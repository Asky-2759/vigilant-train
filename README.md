# vigilant-train

## Integrated browser app (frontend-testing)

Use Python 3.10+ and Node.js 22.12+ (including npm). From the repository root:

```powershell
.\setup.ps1
.\run.ps1
```

For an existing configured Python environment, only `run.ps1` is needed. It
installs frontend dependencies if missing, builds React, and serves the app and
API together at http://127.0.0.1:8077. Re-run after frontend changes. The first
launch downloads/warms the speech models; the page displays readiness.

Put `ELEVENLABS_API_KEY=your-key` in the local `.env` to enable ElevenLabs reference
speech. Never commit `.env`. Without a key, the backend uses its existing gTTS
fallback. eSpeak NG and ffmpeg are still required by the backend.

Put `GEMINI_API_KEY=your-key` (or `GOOGLE_API_KEY=your-key`) in the root `.env`
file to show generated pronunciation advice alongside each score.
`GEMINI_MODEL_ID` can override the default `gemini-3.8-flash` model. Restart
the server after changing `.env` or its environment variables. AI feedback uses
the analyzed words' heard and target IPA; scoring still works if Gemini is not
configured or unavailable.

Enter a sentence, listen to its reference, choose manual or automatic recording,
then record. Automatic mode waits up to 30 seconds for sound and stops after
three seconds of quiet. Either mode limits speech recording to 30 seconds.
Automatic recordings retain the initial waiting audio so the browser's encoded
audio headers remain valid. Use manual mode in noisy rooms.

The browser captures its microphone (not the server's microphone). Uploads are
converted to 16-kHz mono WAV by the existing backend, analysed with its existing
OpenPronounce pipeline, and temporary uploads/WAVs are deleted in a finally block.
The page provides local playback, estimated score, transcription, word-level
comparisons, and reference playback for individual words. The Windows command
line recorder below remains available separately.

For frontend development, run `npm run dev` inside `frontend/`. It starts the
Python API before Vite, or reuses an API already listening on the configured
port. The Vite proxy uses `PRONOUNCE_PORT` from the environment or root `.env`
(default 8077).
Browser microphone access requires localhost or HTTPS.

Validation: `npm run build` inside `frontend/`; install `httpx`, then run
`python -m unittest discover -s tests` from the root after building. API tests
mock model inference and cover upload handoff, cleanup, and invalid audio;
they do not verify live microphone capture or model quality.

## Local microphone recorder (Windows)

The existing browser app uses its own recording and scoring workflow. For a
standalone microphone -> WAV -> OpenPronounce -> comparison workflow, install
`requirements.txt` in your Python environment and run:

```powershell
python practice.py --keep-audio
```

Enter the target sentence, select automatic (1) or manual (2) recording, and
choose the reference accent. Automatic mode starts on sound and stops after
three seconds of silence. Manual mode uses Enter to start and stop. Both cap
recordings at 30 seconds and save 16-kHz mono 16-bit PCM WAV.

`--keep-audio` retains takes in `recordings/` for debugging. Without it, each WAV
is stored in a temporary directory and deleted after the attempt, even on error.
The RMS threshold in `audio_recorder.py` may need adjustment for room noise;
this is volume detection, not speech classification.

Files and handoff:

- `audio_recorder.record(mode, output_dir=None)` returns a closed WAV's `Path`,
  or `None` if no audio was captured.
- `speech_to_ipa.parse_audio(path)` returns IPA segments using OpenPronounce's
  phone recognizer, without the full scoring/TTS pipeline.
- `comparison.compare_pronunciation(text, phones, accent)` returns
  `(kind, detected, expected)` differences.
- `practice.py` connects these steps and manages temporary recording lifetime.

To record only: `python audio_recorder.py`.
To analyze an existing take: `python speech_to_ipa.py recordings/TAKE.wav`.

OpenPronounce 0.3.0 is required. The first phone inference downloads a large
model; warm it up before the demo. The comparator needs eSpeak NG; the practice
runner uses the backend's existing dependency discovery. See `setup.ps1` for
the project's environment setup.

These are strict sequence differences, not calibrated pronunciation grades.
Recognition errors and legitimate pronunciation variants may produce differences.
Unrecognized IPA symbols cause an explicit error rather than silent deletion.
