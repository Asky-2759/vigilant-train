"""ElevenLabs text-to-speech client, and its registration as an OpenPronounce voice.

Two consumers, one cache:

* the browser plays an mp3 of the phrase ("this is how it should sound");
* OpenPronounce's acoustic term needs the *same* phrase as a 16 kHz mono waveform
  to measure the learner's embedding distance against.

:func:`register_openpronounce_backend` plugs the waveform variant into
``openpronounce.tts.BACKENDS`` so that ``audio.text2speech`` -- and therefore
``compare_audio_with_text`` -- uses this voice as the native reference.

Only the standard library is used for HTTP: the call is one POST with a JSON body
and a binary response, which is not worth a dependency.
"""

import hashlib
import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

logger = logging.getLogger(__name__)

API_ROOT = "https://api.elevenlabs.io/v1"
TIMEOUT = 60

#: Raw little-endian 16-bit PCM at 16 kHz -- exactly the rate Wav2Vec2 wants, so the
#: scoring reference needs no decoding and no resampling.
PCM_FORMAT = "pcm_16000"
PCM_SAMPLE_RATE = 16000
#: What the browser plays.
MP3_FORMAT = "mp3_44100_128"

#: ElevenLabs accepts 0.7-1.2; anything outside is a 422.
SPEED_RANGE = (0.7, 1.2)

#: Models that honour an explicit ``language_code`` and the ``<phoneme>`` tag. The
#: multilingual models detect the language themselves and drop tagged words.
_TURBO_PREFIXES = ("eleven_turbo", "eleven_flash")


class ElevenLabsError(RuntimeError):
    """An ElevenLabs request failed. The message is safe to show to the user."""


class ElevenLabs:
    """Thin ElevenLabs client with a disk cache keyed by every parameter that affects audio."""

    def __init__(self, settings):
        self.settings = settings
        self.cache_dir = Path(settings.cache_dir) / "elevenlabs"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._voice_id = settings.voice_id or ""
        self._voices = None

    # -- HTTP ---------------------------------------------------------------

    def _request(self, method, path, *, params=None, body=None):
        url = f"{API_ROOT}{path}"
        if params:
            url = f"{url}?{urllib.parse.urlencode(params)}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {"xi-api-key": self.settings.api_key, "Accept": "*/*"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
                return response.read(), response.headers.get("Content-Type", "")
        except urllib.error.HTTPError as e:
            raise ElevenLabsError(_explain(e)) from e
        except urllib.error.URLError as e:
            raise ElevenLabsError(f"could not reach ElevenLabs ({e.reason})") from e

    def _get_json(self, path, params=None):
        payload, _ = self._request("GET", path, params=params)
        return json.loads(payload.decode("utf-8"))

    # -- Voices & models ----------------------------------------------------

    def voices(self, refresh=False):
        """List the voices available to the account as ``[{id, name, labels}]`` (cached in memory)."""
        if self._voices is None or refresh:
            payload = self._get_json("/voices")
            self._voices = [
                {
                    "id": voice.get("voice_id"),
                    "name": voice.get("name") or voice.get("voice_id"),
                    "labels": voice.get("labels") or {},
                }
                for voice in payload.get("voices", [])
                if voice.get("voice_id")
            ]
        return self._voices

    def curated_voices(self):
        """The voices offered in the picker, as ``[{id, name}]`` with their display labels.

        Only voices the account actually has are returned. If none of them are
        available (a custom workspace, say), fall back to the account's own list
        rather than offering an empty menu.
        """
        available = {voice["id"]: voice for voice in self.voices()}
        chosen = [{"id": voice_id, "name": label}
                  for voice_id, label in self.settings.voices if voice_id in available]
        return chosen or [{"id": v["id"], "name": v["name"]} for v in available.values()]

    def models(self):
        """List the models that can speak, with the languages each supports."""
        payload = self._get_json("/models")
        return [
            {
                "id": model.get("model_id"),
                "name": model.get("name") or model.get("model_id"),
                "languages": [lang.get("language_id") for lang in model.get("languages") or []],
            }
            for model in payload
            if model.get("can_do_text_to_speech", True) and model.get("model_id")
        ]

    def default_voice_id(self):
        """Return the configured voice, or the account's first voice when none is set.

        Picking the first voice means the tool works with only an API key in
        ``.env``; hard-coding a stock voice id would break on accounts that have
        removed it from their library.
        """
        if self._voice_id:
            return self._voice_id
        voices = self.curated_voices()
        if not voices:
            raise ElevenLabsError(
                "this ElevenLabs account has no voices; add one from the ElevenLabs "
                "voice library or set ELEVENLABS_VOICE_ID"
            )
        self._voice_id = voices[0]["id"]
        logger.info("No ELEVENLABS_VOICE_ID set, using %r (%s)", voices[0]["name"], self._voice_id)
        return self._voice_id

    def voice_name(self, voice_id):
        """Human-readable name of a voice id, falling back to the id itself."""
        try:
            for voice in self.curated_voices():
                if voice["id"] == voice_id:
                    return voice["name"]
        except ElevenLabsError:
            pass
        return voice_id

    # -- Synthesis ----------------------------------------------------------

    def synthesize(self, text, *, lang=None, voice_id=None, model_id=None, speed=1.0,
                   output_format=MP3_FORMAT, ipa=None):
        """Synthesize ``text`` and return ``(audio_bytes, content_type, cache_path)``.

        ``ipa`` speaks a literal phone sequence through a ``<phoneme>`` tag instead
        of the spelling, which only some models honour -- hence
        ``settings.phoneme_model_id`` rather than the default model.
        """
        voice_id = voice_id or self.default_voice_id()
        model_id = model_id or (self.settings.phoneme_model_id if ipa else self.settings.model_id)
        speed = min(SPEED_RANGE[1], max(SPEED_RANGE[0], float(speed)))
        spoken = f'<phoneme alphabet="ipa" ph="{_escape(ipa)}">{_escape(text)}</phoneme>' if ipa else text

        path = self._cache_path(spoken, voice_id, model_id, speed, output_format)
        if path.exists():
            return path.read_bytes(), _content_type(output_format), path

        body = {
            "text": spoken,
            "model_id": model_id,
            "voice_settings": {
                "stability": self.settings.stability,
                "similarity_boost": self.settings.similarity_boost,
            },
        }
        if lang and model_id.startswith(_TURBO_PREFIXES):
            body["language_code"] = lang
        if abs(speed - 1.0) > 1e-6:
            body["voice_settings"]["speed"] = speed

        params = {"output_format": output_format}
        endpoint = f"/text-to-speech/{urllib.parse.quote(voice_id)}"
        try:
            payload, content_type = self._request("POST", endpoint, params=params, body=body)
        except ElevenLabsError:
            if "speed" not in body["voice_settings"] and "language_code" not in body:
                raise
            # Some models reject these optional fields; the phrase at normal speed
            # is far better than an error.
            body["voice_settings"].pop("speed", None)
            body.pop("language_code", None)
            logger.warning("Retrying ElevenLabs synthesis without speed/language_code")
            payload, content_type = self._request("POST", endpoint, params=params, body=body)

        if not payload:
            raise ElevenLabsError("ElevenLabs returned no audio")
        path.write_bytes(payload)
        return payload, _content_type(output_format) or content_type, path

    def synthesize_waveform(self, text, *, lang=None, voice_id=None, model_id=None, speed=1.0):
        """Synthesize ``text`` as a ``(mono float32 waveform, 16000)`` pair for scoring."""
        payload, _, _ = self.synthesize(
            text, lang=lang, voice_id=voice_id, model_id=model_id, speed=speed,
            output_format=PCM_FORMAT,
        )
        waveform = np.frombuffer(payload, dtype="<i2").astype(np.float32) / 32768.0
        return waveform, PCM_SAMPLE_RATE

    def _cache_path(self, text, voice_id, model_id, speed, output_format):
        key = hashlib.sha1(
            "\x00".join([text, voice_id, model_id, f"{speed:.3f}", output_format]).encode("utf-8")
        ).hexdigest()
        if output_format.startswith("mp3"):
            suffix = "mp3"
        elif output_format.startswith("pcm"):
            suffix = "pcm"
        else:
            suffix = "bin"
        return self.cache_dir / f"{key}.{suffix}"


def register_openpronounce_backend(client):
    """Make ``elevenlabs`` an OpenPronounce TTS backend, so it voices the scoring reference.

    ``openpronounce.tts.BACKENDS`` maps a name to
    ``(synthesize(text, lang, voice) -> (waveform, sr), default_voice(lang) -> str)``;
    adding an entry is all it takes for ``audio.text2speech`` -- and so
    ``compare_audio_with_text`` -- to use this voice, disk cache included.
    """
    from openpronounce import tts

    def synthesize(text, lang, voice):
        return client.synthesize_waveform(text, lang=lang, voice_id=voice or None)

    tts.BACKENDS["elevenlabs"] = (synthesize, lambda lang: client.default_voice_id())


def _escape(text):
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _content_type(output_format):
    if output_format.startswith("mp3"):
        return "audio/mpeg"
    if output_format.startswith("wav"):
        return "audio/wav"
    if output_format.startswith("opus"):
        return "audio/ogg"
    return "application/octet-stream"


_HTTP_EXPLANATIONS = {
    401: "ElevenLabs rejected the API key (check ELEVENLABS_API_KEY)",
    403: "this ElevenLabs key is not allowed to use that voice or model",
    404: "no such ElevenLabs voice or model",
    422: "ElevenLabs rejected the request",
    429: "ElevenLabs rate limit reached, try again in a moment",
}


def _explain(error):
    """Turn an ElevenLabs HTTP error into a sentence worth putting in the UI."""
    try:
        detail = json.loads(error.read().decode("utf-8")).get("detail")
    except Exception:  # noqa: BLE001 - error bodies are not always JSON
        detail = None
    if isinstance(detail, dict):
        detail = detail.get("message") or detail.get("status")
    base = _HTTP_EXPLANATIONS.get(error.code, f"ElevenLabs returned HTTP {error.code}")
    return f"{base}: {detail}" if detail else base
