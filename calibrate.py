"""Measure ``ACOUSTIC_GOOD`` for the reference voice this install actually uses.

Why this exists
---------------
30% of the score is an *acoustic* term: how far the learner's Wav2Vec2 embeddings
sit from the reference recording's, mapped linearly from ``acoustic_good`` (= 100
points) to ``acoustic_good + 9`` (= 0 points). OpenPronounce ships
``acoustic_good = 6.0`` for English, defined as "the distance between two good
native voices" and measured with gTTS and Piper.

Swap in an ElevenLabs voice and that constant is no longer the right zero point --
the term is then systematically generous or harsh for everyone. This script
re-measures it the same way: synthesize the same sentences with two native voices
and take the distance between them.

Usage
-----
    python calibrate.py                 # the default voice vs a second one
    python calibrate.py --against gtts  # compare against the built-in gTTS voice

Paste the printed line into ``.env`` and restart the server.
"""

import argparse
import statistics
import sys

from fastdtw import fastdtw
from scipy.spatial.distance import euclidean

from backend import scoring, settings as settings_module

# Voice names can carry non-cp1252 characters; a Windows console would die on them.
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")

#: Short, phonetically broad sentences -- enough material for a stable distance
#: without spending much of an ElevenLabs quota.
SENTENCES = [
    "The quick brown fox jumps over the lazy dog.",
    "She thought the third rehearsal would be enough.",
    "Thorough preparation rarely feels urgent.",
]


def distance_between(first, second):
    """Mean per-step DTW distance between the Wav2Vec2 embeddings of two recordings.

    The same quantity ``compare_audio_with_text`` reports as ``acoustic_distance``,
    so the number this prints is directly comparable to a learner's.
    """
    from openpronounce import speech

    embeddings_a = speech.extract_embeddings(first)
    embeddings_b = speech.extract_embeddings(second)
    total, path = fastdtw(embeddings_a, embeddings_b, dist=euclidean)
    return total / max(1, len(path))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--against", default=None,
                        help="voice to compare the reference against: an ElevenLabs voice id, or 'gtts'. "
                             "Default: the second voice on the account, else gtts.")
    args = parser.parse_args()

    settings = settings_module.load()
    report = scoring.init(settings)
    if report["missing"]:
        print(f"Missing system dependencies: {', '.join(report['missing'])}", file=sys.stderr)
        return 1

    primary, secondary = _resolve_voices(settings, args.against)
    print(f"Reference    : {primary['label']}")
    print(f"Compared with: {secondary['label']}")
    print()

    distances = []
    for sentence in SENTENCES:
        try:
            first = scoring.load_audio(primary["synthesize"](sentence))
            second = scoring.load_audio(secondary["synthesize"](sentence))
        except Exception as e:  # noqa: BLE001
            print(f"  skipped {sentence!r}: {e}", file=sys.stderr)
            continue
        distance = distance_between(first, second)
        distances.append(distance)
        print(f"  {distance:6.2f}   {sentence}")

    if not distances:
        print("\nNothing could be synthesized -- check the API key and the network.", file=sys.stderr)
        return 1

    median = statistics.median(distances)
    print(f"\nMedian distance between the two voices: {median:.2f}")
    print("\nAdd this to .env and restart the server:")
    print(f"  ACOUSTIC_GOOD={median:.1f}")
    if len(distances) > 1:
        spread = max(distances) - min(distances)
        if spread > 2.0:
            print(f"\nNote: the per-sentence spread is wide ({spread:.1f}). Add more sentences to "
                  "SENTENCES for a steadier estimate.")
    return 0


def _resolve_voices(settings, against):
    """Pick the two voices to compare, as ``{label, synthesize(text) -> wav path}``."""
    from openpronounce import audio

    def gtts_voice():
        return {
            "label": "gTTS (built in)",
            "synthesize": lambda text: audio.text2speech(
                text, lang=scoring.LANG, backend=settings_module.FALLBACK_TTS, voice=None
            ),
        }

    if not settings.elevenlabs_enabled:
        print("ELEVENLABS_API_KEY is not set, so the reference is already gTTS and the shipped "
              "acoustic_good values apply. Nothing to calibrate.", file=sys.stderr)
        raise SystemExit(0)

    from backend import elevenlabs as elevenlabs_module

    client = elevenlabs_module.ElevenLabs(settings)
    elevenlabs_module.register_openpronounce_backend(client)

    def eleven_voice(voice_id):
        return {
            "label": f"{client.voice_name(voice_id)} (ElevenLabs {settings.model_id})",
            "synthesize": lambda text: audio.text2speech(
                text, lang=scoring.LANG, backend=settings_module.ELEVENLABS_BACKEND, voice=voice_id
            ),
        }

    primary = eleven_voice(client.default_voice_id())

    if against == "gtts":
        return primary, gtts_voice()
    if against:
        return primary, eleven_voice(against)

    others = [voice["id"] for voice in client.curated_voices() if voice["id"] != client.default_voice_id()]
    if others:
        return primary, eleven_voice(others[0])
    print("Only one voice on the account -- comparing against gTTS instead.", file=sys.stderr)
    return primary, gtts_voice()


if __name__ == "__main__":
    raise SystemExit(main())
