# Speech Clarity

A pronunciation practice app with a browser recorder, ElevenLabs reference audio,
and OpenPronounce feedback. The landing page and practice studio now live on main.

## Run the app (Windows)

Install Node.js and Python, then run `./setup.ps1` once and `./run.ps1` to build
and serve the app at http://localhost:8077. Configure the ElevenLabs credentials
in your local `.env` using `.env.example`. Never commit your keys.

The studio supports manual recording and automatic silence stopping, reference
playback, word feedback, and downloading or retrying the latest take. Cancelling
analysis releases the browser controls; server inference may still finish.

## Checks

- Frontend: `cd frontend`, then `npm ci` and `npm run build`.
- Recorder lifecycle (Node 24): `node --test frontend/tests/capture.test.mjs` from the repo root.
- Backend: `python -m unittest discover -s tests` in the configured environment.

Recorder tests simulate repeated takes, cancellation, device errors and denied or
late permissions. Before a demo, also record at least ten real takes in the target
browser: mocked tests cannot verify microphone drivers or actual model accuracy.
Pronunciation scores are estimates and may flag valid accent differences.
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
