"""HTTP API and static host for the pronunciation trainer.

Flow of one practice round, from the browser's point of view:

1. ``POST /api/phonemes`` -- show the IPA of the phrase the learner selected.
2. ``GET  /api/tts``      -- hear it, at normal or reduced speed (ElevenLabs).
3. ``POST /api/analyze``  -- score a recording of the learner reading it.
4. ``GET  /api/reference`` -- replay the exact recording the score was measured against.

The Wav2Vec2 checkpoints are loaded once, in a background thread at startup;
``GET /api/health`` reports that progress and any missing system dependency so the
page can explain itself instead of hanging on the first recording.
"""

import logging
import os
import tempfile
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

from . import elevenlabs as elevenlabs_module
from . import scoring, settings as settings_module

logging.basicConfig(level=os.environ.get("PRONOUNCE_LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)-7s %(name)s  %(message)s")
logger = logging.getLogger("pronounce")

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"
DIST = FRONTEND / "dist"

SETTINGS = settings_module.load()

# Startup progress, served from /api/health.
_state = {"models": "cold", "error": None, "native": None}
_client = None


def _warm():
    _state["models"] = "warming"
    try:
        scoring.warm()
        _state["models"] = "ready"
        logger.info("Models ready")
    except Exception as e:  # noqa: BLE001 - surfaced through /api/health
        _state["models"] = "error"
        _state["error"] = str(e)
        logger.exception("Model warm-up failed")


@asynccontextmanager
async def lifespan(app):
    global _client

    _state["native"] = scoring.init(SETTINGS)
    if _state["native"]["missing"]:
        logger.warning("Missing system dependencies: %s", ", ".join(_state["native"]["missing"]))

    if SETTINGS.elevenlabs_enabled:
        _client = elevenlabs_module.ElevenLabs(SETTINGS)
        elevenlabs_module.register_openpronounce_backend(_client)
        logger.info("ElevenLabs enabled, model %s", SETTINGS.model_id)
    else:
        logger.warning("ELEVENLABS_API_KEY not set -- falling back to gTTS for the reference voice")

    # Chosen here instead of in .env so the fallback is automatic.
    os.environ["OPENPRONOUNCE_TTS"] = SETTINGS.reference_backend

    if SETTINGS.warm_on_start:
        threading.Thread(target=_warm, name="warm-models", daemon=True).start()
    else:
        _state["models"] = "ready"  # Models load lazily on first analysis.
    yield


app = FastAPI(title="Pronunciation Trainer", version="1.0.0", lifespan=lifespan)



# Pages


@app.get("/", include_in_schema=False)
def index():
    if not (DIST / "index.html").is_file():
        return HTMLResponse("Frontend not built. Run npm ci and npm run build in frontend/.", status_code=503)
    return HTMLResponse((DIST / "index.html").read_text(encoding="utf-8"))


app.mount("/assets", StaticFiles(directory=DIST / "assets", check_dir=False), name="assets")


# Status


@app.get("/api/health")
def health():
    """Startup progress and system dependencies, polled by the page until ready."""
    native = _state["native"] or {}
    return {
        "models": _state["models"],
        "error": _state["error"],
        "ready": _state["models"] == "ready" and not native.get("missing"),
        "native": native,
    }


@app.get("/api/config")
def config():
    """Everything the page needs to render itself: voice, scoring reference, limits."""
    reference = {"backend": SETTINGS.reference_backend, "voice": None, "voice_id": None}
    if _client is not None:
        try:
            reference["voice_id"] = _client.default_voice_id()
            reference["voice"] = _client.voice_name(reference["voice_id"])
        except elevenlabs_module.ElevenLabsError as e:
            reference["error"] = str(e)

    return {
        "elevenlabs": SETTINGS.elevenlabs_enabled,
        "model_id": SETTINGS.model_id if SETTINGS.elevenlabs_enabled else None,
        "phoneme_model_id": SETTINGS.phoneme_model_id if SETTINGS.elevenlabs_enabled else None,
        "slow_speed": SETTINGS.slow_speed,
        "reference": reference,
        "max_text_chars": SETTINGS.max_text_chars,
    }


@app.get("/api/voices")
def voices():
    """Voices on the ElevenLabs account, for the voice picker."""
    if _client is None:
        return {"voices": [], "selected": None}
    try:
        voices = _client.curated_voices()
        selected = _client.default_voice_id()
        if selected not in {voice["id"] for voice in voices}:
            selected = voices[0]["id"] if voices else selected
        return {"voices": voices, "selected": selected}
    except elevenlabs_module.ElevenLabsError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


# Practice round

@app.post("/api/phonemes")
def phonemes(text: str = Form(...)):
    """Per-word IPA of the selected phrase."""
    text = _check_text(text)
    try:
        return scoring.expected_phonemes(text)
    except Exception as e:  # noqa: BLE001
        logger.exception("phonemization failed")
        raise HTTPException(status_code=500, detail=f"could not phonemize that text: {e}") from e


@app.get("/api/tts")
def tts(text: str = Query(...), speed: float = Query(1.0),
        voice_id: str = Query(None), ipa: str = Query(None)):
    """Speak ``text`` -- the model pronunciation the learner is aiming at.

    ``speed`` below 1 slows the delivery without dropping the pitch, which is what
    makes a hard cluster audible. ``ipa`` speaks a phone sequence literally instead
    of the spelling, for the odd word the voice reads wrong.
    """
    text = _check_text(text)

    if _client is not None:
        try:
            payload, content_type, _ = _client.synthesize(
                text, lang=scoring.LANG, speed=speed, voice_id=voice_id or None, ipa=ipa or None
            )
            return Response(content=payload, media_type=content_type,
                            headers={"Cache-Control": "public, max-age=86400"})
        except elevenlabs_module.ElevenLabsError as e:
            logger.warning("ElevenLabs TTS failed, falling back to the local voice: %s", e)

    # No key, or ElevenLabs is down: the bundled gTTS voice still teaches the phrase.
    try:
        return FileResponse(scoring.fallback_wav(text, speed), media_type="audio/wav",
                            headers={"Cache-Control": "public, max-age=86400",
                                     "X-Pronounce-Voice": "fallback"})
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"no voice available: {e}") from e


@app.get("/api/reference")
def reference(text: str = Query(...), voice_id: str = Query(None)):
    """The exact 16 kHz recording the acoustic term of the score was measured against."""
    text = _check_text(text)
    try:
        path = scoring.reference_wav(text, voice_id or None)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"could not synthesize the reference: {e}") from e
    return FileResponse(path, media_type="audio/wav",
                        headers={"Cache-Control": "public, max-age=86400"})


@app.post("/api/analyze")
def analyze(file: UploadFile = File(...), expected_text: str = Form(...), voice_id: str = Form(None)):
    """Score a recording against the phrase the learner selected."""
    expected_text = _check_text(expected_text)

    if _state["models"] == "error":
        raise HTTPException(status_code=503, detail=f"the models failed to load: {_state['error']}")
    native = _state["native"] or {}
    if native.get("missing"):
        missing = ", ".join(native["missing"])
        hints = "; ".join(native.get("hints", {}).values())
        raise HTTPException(status_code=503, detail=f"missing system dependency: {missing}. Install with: {hints}")

    upload_path = wav_path = None
    try:
        upload_path = _save_upload(file)
        wav_path = _to_wav(upload_path)
        return scoring.analyze(wav_path, expected_text, voice_id or None)
    except scoring.AnalysisError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        logger.exception("analysis failed")
        raise HTTPException(status_code=500, detail=f"analysis failed: {e}") from e
    finally:
        for path in (upload_path, wav_path):
            if path:
                try:
                    os.remove(path)
                except OSError:
                    pass


# Helpers

def _check_text(text):
    text = (text or "").strip()
    if not text:
        raise HTTPException(status_code=422, detail="no text to practice")
    if len(text) > SETTINGS.max_text_chars:
        raise HTTPException(
            status_code=422,
            detail=f"select at most {SETTINGS.max_text_chars} characters -- a sentence or two scores far "
                   "more usefully than a paragraph",
        )
    return text


def _save_upload(upload):
    """Write the uploaded recording to a temp file, refusing anything oversized."""
    suffix = Path(upload.filename or "").suffix or ".webm"
    handle, path = tempfile.mkstemp(suffix=suffix, prefix="pronounce-upload-")
    size = 0
    try:
        with os.fdopen(handle, "wb") as buffer:
            while chunk := upload.file.read(1 << 20):
                size += len(chunk)
                if size > SETTINGS.max_upload_bytes:
                    raise HTTPException(status_code=413, detail="that recording is too large")
                buffer.write(chunk)
    except BaseException:
        try:
            os.remove(path)
        except OSError:
            pass
        raise
    if not size:
        try:
            os.remove(path)
        except OSError:
            pass
        raise HTTPException(status_code=422, detail="the recording was empty -- check microphone access")
    return path


def _to_wav(path):
    """Decode a browser recording (webm/opus, mp4, wav...) to 16 kHz mono wav."""
    from openpronounce import audio

    return audio.webm2wav(path)
