r"""Configuration, read once from the environment and from ``.env``.

Everything the tool needs to be told the ElevenLabs credentials, which voice
speaks the reference, where to cache audio lives here so that no other module
reads ``os.environ`` directly.
"""

import os
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# The voices offered in the picker, in display order, with the label shown for
# each. ElevenLabs stock voices, so the ids are the same on every account
VOICES = (
    ("nPczCjzI2devNBz1zQrb", "Lower Male Voice"),     # Brian
    ("cjVigY5qzO86Huf0OWal", "Higher Male Voice"),    # Eric
    ("XrExE9yKIg1WjnnlVkGX", "Lower Female Voice"),   # Matilda
    ("hpp4J3VqNfWAUOO0d1Us", "Higher Female Voice"),  # Bella
)

# Fallback if ElevenLabs is not configured: Google Translate TTS, which
# OpenPronounce ships and calibrated its acoustic score against.
FALLBACK_TTS = "gtts"
ELEVENLABS_BACKEND = "elevenlabs"


def load_dotenv(path=None):
    #Load KEY=value lines from .env into the environment without overriding it
    
    path = Path(path) if path else ROOT / ".env"
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


def _flag(name, default=False):
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() not in ("", "0", "false", "no", "off")


def _float(name, default):
    try:
        return float(os.environ[name])
    except (KeyError, ValueError):
        return default


@dataclass(frozen=True)
class Settings:
    # Resolved configuration for one run of the server

    api_key: str = ""
    voice_id: str = ""
    model_id: str = "eleven_multilingual_v2"
    # Model used when speaking raw IPA through a <phoneme> tag. Only some
    # ElevenLabs models honour those tags (flash v2 and the v3 family); the
    # multilingual models silently drop the tagged word, so the IPA button uses
    # this one instead of model_id
    phoneme_model_id: str = "eleven_flash_v2"
    stability: float = 0.5
    similarity_boost: float = 0.75
    slow_speed: float = 0.7
    # Override of OpenPronounce's English acoustic_good. the
    # embedding distance that maps to 100% on the acoustic term. Its shipped
    # values were measured against gTTS, so a different reference voice wants a
    # remeasured value
    acoustic_good: float | None = None
    voices: tuple = VOICES
    host: str = "127.0.0.1"
    port: int = 8077
    cache_dir: Path = ROOT / ".cache"
    warm_on_start: bool = True
    max_upload_bytes: int = 25 * 1024 * 1024
    max_text_chars: int = 400

    @property
    def elevenlabs_enabled(self):
        return bool(self.api_key)

    @property
    def reference_backend(self):
        # TTS backend that voices the reference, for playback and for scoring.

        # One voice does both on purpose: the acoustic term of the score measures how
        # far the learner is from this recording, so the learner has to be able to
        # hear the exact thing they are scored against.

        return ELEVENLABS_BACKEND if self.elevenlabs_enabled else FALLBACK_TTS


def load():
    """Build :class:`Settings` from ``.env`` + the environment."""
    load_dotenv()
    try:
        acoustic_good = float(os.environ["ACOUSTIC_GOOD"])
    except (KeyError, ValueError):
        acoustic_good = None
    return Settings(
        api_key=os.environ.get("ELEVENLABS_API_KEY", "").strip(),
        voice_id=os.environ.get("ELEVENLABS_VOICE_ID", "").strip(),
        model_id=os.environ.get("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2").strip(),
        phoneme_model_id=os.environ.get("ELEVENLABS_PHONEME_MODEL_ID", "eleven_flash_v2").strip(),
        stability=_float("ELEVENLABS_STABILITY", 0.5),
        similarity_boost=_float("ELEVENLABS_SIMILARITY_BOOST", 0.75),
        slow_speed=_float("ELEVENLABS_SLOW_SPEED", 0.7),
        acoustic_good=acoustic_good,
        host=os.environ.get("PRONOUNCE_HOST", "127.0.0.1").strip(),
        port=int(os.environ.get("PRONOUNCE_PORT", "8077")),
        cache_dir=Path(os.environ.get("PRONOUNCE_CACHE_DIR", str(ROOT / ".cache"))),
        warm_on_start=_flag("PRONOUNCE_WARM_ON_START", True),
    )
