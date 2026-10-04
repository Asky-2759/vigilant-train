"""The assessment layer: OpenPronounce, plus the extras the UI needs to explain a score.

OpenPronounce does the hard part. This module

* keeps the heavy Wav2Vec2 models warm and serialises access to them,
* re-grades the word term so the recognizer's word spacing ("TO DAY" for "today")
  is not counted against the speaker, and rebuilds the score from it,
* decomposes the 0-100 score back into the three terms it is made of, so the UI can
  say *why* a reading scored what it scored,
* joins ``compare_phones`` errors back onto every expected word (not only the wrong
  ones), and splits the heard sounds into the same words, so the UI can paint the
  whole phrase and line heard up against expected,
* and degrades to a reference-free score when the voice cannot be synthesised.

Nothing here imports OpenPronounce at module level: :func:`init` runs the native
dependency bootstrap first.
"""

import logging
import os
import re
import subprocess
import threading
from contextlib import contextmanager
from dataclasses import replace

import numpy as np

from . import settings as settings_module
from .quality import recording_quality
from .guidance import practice_guidance

logger = logging.getLogger(__name__)

#: English only. OpenPronounce's phone targets, accepted alternate pronunciations
#: and score calibration are all American English; the other languages it ships
#: are experimental and not offered here.
LANG = "en"

#: A recording shorter or quieter than this is a slip (mic not granted, button
#: double-tapped), not a bad reading: better to say so than to return a 0.
MIN_DURATION_SECONDS = 0.25
MIN_PEAK_AMPLITUDE = 0.005

SCORE_BANDS = (
    (90, "strong reference match", "good"),
    (75, "great", "good"),
    (60, "good", "warning"),
    (40, "getting there", "serious"),
    (0, "needs work", "critical"),
)

#: Serialises the Wav2Vec2 forward passes. The models are not meant to be entered
#: concurrently, and on CPU two parallel analyses are slower than two sequential
#: ones anyway.
_lock = threading.Lock()

_audio = _speech = _phones = _languages = None


class AnalysisError(RuntimeError):
    """The recording cannot be assessed. The message is meant for the user."""


def init(settings):
    """Import OpenPronounce (after the native bootstrap) and apply configuration.

    Returns the bootstrap report so the caller can surface missing system
    dependencies instead of failing on the first analysis.
    """
    global _audio, _speech, _phones, _languages

    from . import bootstrap

    report = bootstrap.configure()

    # Hugging Face and transformers are chatty on import and on every checkpoint
    # load: a symlink warning Windows always triggers, two weight-loading progress
    # bars, and a "newly initialized params" report for a head we never train.
    # None of it is actionable here, and it buries our own startup log.
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    os.environ.setdefault("TRANSFORMERS_VERBOSITY", "error")

    from openpronounce import audio, languages, phones, speech

    _audio, _speech, _phones, _languages = audio, speech, phones, languages

    # The shipped acoustic_good was measured against gTTS; a different reference
    # voice wants a re-measured one (see calibrate.py).
    if settings.acoustic_good is not None:
        languages.LANGUAGES[LANG] = replace(languages.LANGUAGES[LANG], acoustic_good=settings.acoustic_good)
        logger.info("acoustic_good overridden to %.2f", settings.acoustic_good)

    _audio.CACHE_DIR = str(settings.cache_dir / "reference")
    return report


def warm():
    """Pay every one-time cost the first analysis would otherwise charge the learner.

    Called in a background thread at startup. Three separate costs hide here, and
    missing any one of them puts a minute of silence between "stop recording" and
    a score:

    * the two Wav2Vec2 checkpoints, ~1.2 GB each, loaded from disk (or downloaded);
    * espeak, which phonemizer loads lazily through ctypes;
    * librosa's numba kernels, which JIT-compile on first call -- ``pyin`` alone is
      tens of seconds the first time it runs in a process. Nothing here shows pitch,
      but ``compare_audio_with_text`` computes it on every call regardless.
    """
    with _lock:
        silence = np.zeros(_speech.SAMPLING_RATE // 2, dtype=np.float32)
        # Not quite silence: pyin on a flat zero signal finds no pitch and skips
        # part of the code path we are trying to compile.
        tone = (0.1 * np.sin(2 * np.pi * 120 * np.arange(len(silence)) / _speech.SAMPLING_RATE)).astype(np.float32)

        _speech.extract_embeddings(silence)
        _speech.transcribe(silence, LANG)
        if _phones.is_enabled():
            _phones.recognize_phones(silence, lang=LANG)
        _phones.get_expected_phones("warm up the phonemizer", LANG)

        _speech.extract_energy(tone)
        _speech.interpolate_f0(_speech.extract_f0(tone))


# ---------------------------------------------------------------------------
# Phonemes
# ---------------------------------------------------------------------------

def expected_phonemes(text):
    """Per-word IPA for ``text``: ``[{word, ipa, phones}]`` plus the joined transcription."""
    words, groups = _phones.get_expected_phones(text, LANG)
    items = [
        {"word": word, "phones": list(group), "ipa": "".join(group)}
        for word, group in zip(words, groups)
    ]
    return {"words": items, "ipa": " ".join(item["ipa"] for item in items if item["ipa"])}


# ---------------------------------------------------------------------------
# Reference voice
# ---------------------------------------------------------------------------

def reference_wav(text, voice_id=None):
    """Path to the 16 kHz reference recording of ``text`` (synthesised once, then cached)."""
    return _audio.text2speech(text, lang=LANG, voice=voice_id or None)


def fallback_wav(text, speed=1.0):
    """Reference recording from the bundled gTTS voice, whatever the configured backend.

    Used when ElevenLabs is unreachable or unconfigured. gTTS has no speed control,
    so a slowed copy is made with ffmpeg's ``atempo`` filter, which changes the
    tempo without changing the pitch. Cached next to the normal recording.
    """
    path = _audio.text2speech(text, lang=LANG, backend=settings_module.FALLBACK_TTS, voice=None)
    speed = min(1.0, max(0.5, float(speed)))
    if speed >= 0.999:
        return path
    slowed = f"{path[:-4]}.x{speed:.2f}.wav"
    if not os.path.exists(slowed):
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-i", path, "-filter:a", f"atempo={speed:.3f}", slowed],
            check=True,
        )
    return slowed


@contextmanager
def _pinned_voice(voice_id):
    """Pin the reference voice for the duration of a block.

    ``compare_audio_with_text`` synthesises its own reference and resolves the voice
    through ``OPENPRONOUNCE_TTS_VOICE``, so that env var is the only way to steer it
    without reimplementing the function. Safe because :func:`analyze` holds ``_lock``
    for the whole analysis, and the voice is part of the TTS cache key either way.
    """
    if not voice_id:
        yield
        return
    previous = os.environ.get("OPENPRONOUNCE_TTS_VOICE")
    os.environ["OPENPRONOUNCE_TTS_VOICE"] = voice_id
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop("OPENPRONOUNCE_TTS_VOICE", None)
        else:
            os.environ["OPENPRONOUNCE_TTS_VOICE"] = previous


def load_audio(path):
    return _audio.load(path)


# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------

def analyze(wav_path, expected_text, voice_id=None):
    """Assess ``wav_path`` against ``expected_text`` and return the payload the UI renders.

    On top of OpenPronounce's result the payload carries ``breakdown`` (the three
    weighted terms behind the score), ``words`` (every expected word with its IPA
    and its verdict), ``band`` and the grouped heard IPA.

    ``voice_id`` pins the reference voice, so the recording the learner heard is the
    one the acoustic term measures them against.
    """
    waveform = _audio.load(wav_path)
    _check_recording(waveform)

    with _lock, _pinned_voice(voice_id):
        reference_path, reference_error = _synthesize_reference(expected_text, voice_id)
        if reference_path is not None:
            result = _speech.compare_audio_with_text(waveform, expected_text, lang=LANG)
        else:
            result = _analyze_without_reference(waveform, expected_text)
            result["reference_error"] = reference_error

    differences = result.get("differences", {})
    result["has_reference"] = reference_path is not None

    # OpenPronounce's word error rate punishes the recognizer's spacing, not the
    # speaker: "today" transcribed as "TO DAY" costs two errors. Re-grade with
    # word boundaries ignored, then rebuild the score from the corrected term.
    differences["word_error_rate_raw"] = differences.get("word_error_rate")
    differences["word_error_rate"] = round(
        boundary_tolerant_wer(expected_text, result.get("transcribe") or ""), 4
    )
    # The upstream overall PER is strict edit distance even though its word flags
    # accept variants and near sounds. Use that same variant inventory for the
    # sound dimension so an accepted pronunciation does not quietly lose points.
    differences["phoneme_error_rate_raw"] = differences.get("phoneme_error_rate")
    tolerant_rate = variant_aware_phone_rate(expected_text, differences)
    result["sound_comparison"] = "strict" if tolerant_rate is None else "variant-aware"
    if tolerant_rate is not None:
        differences["phoneme_error_rate"] = round(tolerant_rate, 4)
    result["score"] = _total_score(result.get("acoustic_distance"), differences)

    heard_by_word = _heard_by_word(expected_text, differences)
    result["breakdown"] = _breakdown(result, differences)
    result["words"] = _word_verdicts(expected_text, differences, heard_by_word)
    result["band"] = _band(result["score"])
    result["heard_ipa"] = (
        " ".join(heard for heard in heard_by_word.values() if heard)
        if heard_by_word is not None
        else "".join(differences.get("heard_phones") or [])
    )
    result["duration"] = round(len(waveform) / _speech.SAMPLING_RATE, 2)
    result["recording_quality"] = recording_quality(waveform, _speech.SAMPLING_RATE)
    result["guidance"] = practice_guidance(result["words"], result["recording_quality"], differences["word_error_rate"])
    # Pitch and loudness curves: not part of the score, and not shown, since pitch
    # varies with mood and emphasis rather than with pronunciation.
    result.pop("prosody", None)
    return _jsonable(result)


#: Longest run of words merged on either side when matching across a split or a
#: join ("every one" / "everyone", "to day" / "today", "a lot" / "alot").
_MAX_MERGE = 3

_WORD_TOKEN_RE = re.compile(r"[\w']+")


def variant_aware_phone_rate(text, differences):
    """Accepted variants and near-phone costs, without a second model pass.

    Uses the pinned OpenPronounce alignment helper with decoded phones only;
    this does NOT reuse frame posteriors or estimate human-rated accuracy.
    Fall back to strict PER if all heard/expected phones cannot be accounted for.
    Entirely missing words cost their full expected length.
    """
    if "heard_phones" not in differences or "expected_phones" not in differences:
        return None
    heard = differences["heard_phones"]
    expected_count = sum(len(group) for group in differences["expected_phones"])
    if not expected_count:
        return None
    try:
        reports = _phones._word_reports(heard, text, LANG)
        if sum(len(r["actual"]) for r in reports) != len(heard):
            return None
        if sum(len(r["expected"]) for r in reports) != expected_count:
            return None
        edits = sum(len(r["expected"]) if not r["actual"] else r["weighted_edits"] for r in reports)
        if not np.isfinite(edits) or edits < 0:
            return None
        return edits / expected_count
    except (AttributeError, KeyError, TypeError, ValueError):
        logger.warning("Variant-aware phone alignment unavailable; using strict PER")
        return None


def boundary_tolerant_wer(expected_text, transcription):
    """Word error rate that ignores where the recognizer put word boundaries.

    A plain WER aligns word lists, so a single word transcribed as two ("today"
    -> "to day") costs a substitution *and* an insertion: two errors for a word
    said correctly. Here, a run of up to :data:`_MAX_MERGE` expected words that
    spells exactly the same as a run of transcribed words (spaces and case
    ignored) aligns at no cost. Every other edit costs 1, as usual.
    """
    expected = [w.lower() for w in _WORD_TOKEN_RE.findall(expected_text)]
    heard = [w.lower() for w in _WORD_TOKEN_RE.findall(transcription)]
    if not expected:
        return 0.0 if not heard else 1.0

    rows, cols = len(expected), len(heard)
    inf = float("inf")
    cost = [[inf] * (cols + 1) for _ in range(rows + 1)]
    cost[0][0] = 0
    for i in range(rows + 1):
        for j in range(cols + 1):
            here = cost[i][j]
            if here == inf:
                continue
            if i < rows:
                cost[i + 1][j] = min(cost[i + 1][j], here + 1)            # missing word
            if j < cols:
                cost[i][j + 1] = min(cost[i][j + 1], here + 1)            # extra word
            if i < rows and j < cols:
                step = 0 if expected[i] == heard[j] else 1                 # match / substitution
                cost[i + 1][j + 1] = min(cost[i + 1][j + 1], here + step)
            # Same letters, different spacing: free.
            for a in range(1, _MAX_MERGE + 1):
                if i + a > rows:
                    break
                spelled = "".join(expected[i:i + a])
                for b in range(1, _MAX_MERGE + 1):
                    if j + b > cols or (a == 1 and b == 1):
                        continue
                    if "".join(heard[j:j + b]) == spelled:
                        cost[i + a][j + b] = min(cost[i + a][j + b], here)
    return cost[rows][cols] / rows


def _total_score(acoustic_distance, differences):
    """Recombine the three terms into the 0-100 score, the way OpenPronounce does.

    Without a reference recording there is no acoustic term, so the remaining two
    are renormalised to 100% rather than capping every score at 70.
    """
    phoneme_error_rate = differences.get("phoneme_error_rate", 1.0)
    word_error_rate = differences.get("word_error_rate", 1.0)
    if acoustic_distance is not None:
        return _speech.compute_pronunciation_score(acoustic_distance, phoneme_error_rate, word_error_rate, LANG)
    weights = _speech.SCORE_WEIGHTS
    total = weights["phonemes"] + weights["words"]
    score = (
        weights["phonemes"] * _clip(100 * (1 - phoneme_error_rate))
        + weights["words"] * _clip(100 * (1 - word_error_rate))
    ) / total
    return round(_clip(score), 2)


def _heard_by_word(expected_text, differences):
    """The heard sounds split into the expected words, as ``{word position: ipa}``.

    The phone recognizer emits one unbroken stream, while the expected IPA is
    shown word by word; printed side by side, the unbroken one reads as wrong
    even where every sound matches. This uses the same alignment that decides
    which words are flagged, so heard and expected line up word for word.

    Returns ``None`` when the stream cannot be split cleanly -- ``_word_reports``
    is a private OpenPronounce helper, and a partial split would misattribute
    sounds to the wrong word.
    """
    heard = list(differences.get("heard_phones") or [])
    if not heard:
        return {}
    try:
        reports = _phones._word_reports(heard, expected_text, LANG)
    except Exception as e:  # noqa: BLE001 - private helper; callers fall back to the raw stream
        logger.debug("could not group heard phones by word: %s", e)
        return None
    if sum(len(report["actual"]) for report in reports) != len(heard):
        return None
    return {report["position"]: "".join(report["actual"]) for report in reports}


def _check_recording(waveform):
    if not np.isfinite(waveform).all():
        raise AnalysisError("that recording contains invalid audio data -- please record a new take")
    if waveform.size / _speech.SAMPLING_RATE < MIN_DURATION_SECONDS:
        raise AnalysisError("that recording is too short to score -- hold the button and read the phrase")
    if float(np.abs(waveform).max(initial=0.0)) < MIN_PEAK_AMPLITUDE:
        raise AnalysisError("that recording is silent -- check that the right microphone is selected")


def _synthesize_reference(text, voice_id=None):
    """Return ``(path, None)``, or ``(None, reason)`` when the reference voice is unavailable."""
    try:
        return reference_wav(text, voice_id), None
    except Exception as e:  # noqa: BLE001 - no network, no API key, voice removed...
        logger.warning("reference synthesis failed: %s", e)
        return None, str(e)


def _analyze_without_reference(waveform, expected_text):
    """Score without the acoustic term, re-weighting the two terms that remain.

    Reached when the reference voice cannot be synthesised (offline, bad API key).
    The phone and word terms carry 70% of the score between them, so they are
    renormalised to 100% rather than silently capping every score at 70.
    """
    transcription = _speech.transcribe(waveform, LANG)
    differences = _speech.compare_transcriptions(transcription, expected_text, LANG)

    if _phones.is_enabled():
        recognition = _phones.recognize_phones(waveform, lang=LANG)
        phone_result = _phones.compare_phones(recognition, expected_text, LANG)
        differences.update({
            "errors": phone_result["errors"],
            "words_with_errors": phone_result["words_with_errors"],
            "phoneme_error_rate": phone_result["phone_error_rate"],
            "expected_phones": phone_result["expected_phones"],
            "heard_phones": phone_result["heard_phones"],
            "heard_phones_confidence": phone_result["heard_phones_confidence"],
        })

    return {
        # Provisional: analyze() re-grades the word term and recomputes this.
        "score": _total_score(None, differences),
        "distance": None,
        "acoustic_distance": None,
        "differences": differences,
        "feedback": differences.get("feedback", ""),
        "transcribe": transcription,
        "language": LANG,
    }


def _breakdown(result, differences):
    """The three terms behind the score, each 0-100 with the weight it carries.

    Uses OpenPronounce's own constants so the parts always reconstruct the whole:
    the acoustic term maps the embedding distance from ``acoustic_good`` (100) to
    ``acoustic_good + ACOUSTIC_DISTANCE_SPAN`` (0).
    """
    weights = dict(_speech.SCORE_WEIGHTS)
    acoustic_distance = result.get("acoustic_distance")

    if acoustic_distance is None:
        # Reference-free scoring renormalised the two remaining terms.
        total = weights["phonemes"] + weights["words"]
        weights = {"phonemes": weights["phonemes"] / total, "words": weights["words"] / total}
        acoustic = None
    else:
        good = _languages.get_language(LANG).acoustic_good
        acoustic = _clip(100 * (1 - (acoustic_distance - good) / _speech.ACOUSTIC_DISTANCE_SPAN))

    terms = [
        {
            "key": "sounds",
            "label": "Sounds",
            "hint": "Estimated sound-sequence agreement. Recognition errors and valid variants can affect this.",
            "value": round(_clip(100 * (1 - differences.get("phoneme_error_rate", 1.0))), 1),
            "weight": weights["phonemes"],
            "detail": f"phoneme error rate {differences.get('phoneme_error_rate', 0):.0%}",
        },
        {
            "key": "words",
            "label": "Words",
            "hint": "Agreement between the requested words and the machine transcript, allowing spacing differences. Not a human intelligibility test.",
            "value": round(_clip(100 * (1 - differences.get("word_error_rate", 1.0))), 1),
            "weight": weights["words"],
            "detail": f"word error rate {differences.get('word_error_rate', 0):.0%}",
        },
    ]
    if acoustic is not None:
        terms.append({
            "key": "voice",
            "label": "Reference similarity",
            "hint": "Acoustic similarity to the reference. Voice and recording conditions can affect it; matching the speaker's identity is not the goal.",
            "value": round(acoustic, 1),
            "weight": weights["acoustic"],
            "detail": f"embedding distance {acoustic_distance:.2f} (best {good:.0f})",
        })
    return terms


def _word_verdicts(expected_text, differences, heard_by_word=None):
    """Every expected word with its IPA and verdict, wrong ones carrying the phone diff.

    ``compare_phones`` reports only the words it considers mispronounced, keyed by
    their index in the phrase; the UI needs the correct ones too in order to paint
    the phrase, so the two are joined here on that index. ``heard_by_word`` (from
    :func:`_heard_by_word`) supplies what was actually heard for the correct words
    too -- an accepted variant like /ɚ/ for "are" -- rather than echoing the target.
    """
    words, groups = _phones.get_expected_phones(expected_text, LANG)
    errors = {error["position"]: error for error in differences.get("errors") or []}

    verdicts = []
    for position, (word, group) in enumerate(zip(words, groups)):
        error = errors.get(position)
        confidence = float(error.get("confidence", 1.0)) if error else 0.0
        if error:
            heard = error.get("actual") or ""
        elif heard_by_word is not None:
            heard = heard_by_word.get(position, "")
        else:
            # Do not present expected sounds as if they were actually detected.
            heard = ""
        verdicts.append({
            "position": position,
            "word": word,
            "expected": "".join(group),
            "heard": heard,
            "status": _word_status(bool(error), confidence),
            "confidence": round(confidence, 3),
            # Per-phone diff, each phone with how sure we are it was wrong (0-1).
            "phones": [
                {
                    "expected": phone["expected"],
                    "heard": phone["heard"],
                    "confidence": phone["confidence"],
                }
                for phone in (error.get("phones") or [] if error else [])
            ],
        })
    return verdicts


def _word_status(has_error, confidence):
    if not has_error:
        return "ok"
    return "wrong" if confidence >= 0.65 else "close"


def _band(score):
    for threshold, label, status in SCORE_BANDS:
        if score >= threshold:
            return {"label": label, "status": status}
    return {"label": "needs work", "status": "critical"}


def _clip(value):
    return min(100.0, max(0.0, float(value)))


def _jsonable(value):
    """Convert numpy scalars/arrays left in the result into plain JSON types."""
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if isinstance(value, np.ndarray):
        return _jsonable(value.tolist())
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, float) and (np.isnan(value) or np.isinf(value)):
        return None
    return value
