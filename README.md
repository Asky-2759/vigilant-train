<<<<<<< Updated upstream
# vigilant-train
=======
# Speech Clarity

Paste English text, select a phrase, read it aloud, get a score and hear how it should
have sounded.

Scoring is [OpenPronounce](https://github.com/Halleck45/OpenPronounce) (Wav2Vec2
phone recognition + DTW) running locally, so your recordings never leave the machine.
The model voice is ElevenLabs.

```
 text in  →  select a phrase  →  hear it  →  record or upload  →  score + per-sound diff
```

English only. OpenPronounce's sound targets and score calibration are American
English.

## What it does

* **Select to practise.** Drag across any words for a phrase, click a single word to
  drill it, or hover a sentence and hit its `▶`. The IPA of the selection appears
  straight away.
* **Hear the target first**, at full speed or slowed to 0.7×, which is what makes a
  hard consonant cluster audible. For a word the voice reads wrong, *Hear the sounds
  only* speaks the raw IPA through a `<phoneme>` tag.
* **Four voices**, picked from the header: Lower Male, Higher Male, Lower Female and
  Higher Female. Your choice is remembered, and switching says the current phrase in
  the new voice.
* **Record or upload.** Use the microphone, or score an audio file you already have.
* **Score out of 100**, broken into the three terms it is actually made of:

  | Term | Weight | What it measures |
  |---|---|---|
  | Sounds | 40% | share of expected phonemes you produced (phone error rate) |
  | Words | 30% | how much a listener would transcribe correctly (word error rate) |
  | Voice match | 30% | embedding distance from the selected voice's reading |

* **Word by word.** Every word carries its expected IPA. Flagged ones open a per-sound
  diff (expected sound on top, what was heard underneath) with a *Drill this word*
  button.
* **A/B playback** of your recording against the exact reference the score was
  measured against, plus a per-phrase attempt history.

## Setup

Needs Python 3.10+ and, on Windows, `winget`. `setup.ps1` handles everything else.

```powershell
cd pronounce
.\setup.ps1            # espeak-ng + ffmpeg + .venv + torch + models (~2.4 GB)
# .\setup.ps1 -SkipModels   to defer the model download
# .\setup.ps1 -Gpu          for CUDA torch wheels instead of CPU
```

Put your ElevenLabs key in `.env` (created from `.env.example` by the setup script):

```ini
ELEVENLABS_API_KEY=sk_...
```

Create the key at https://elevenlabs.io/app/settings/api-keys. If the dashboard offers
permission options, the key needs **Text to Speech** and read access to **Voices**.

```powershell
.\run.ps1              # http://127.0.0.1:8077
```

The speech models load in the background at startup. The status pill in the header
turns green when recording is available. After changing `.env`, stop the server with
Ctrl+C and run `.\run.ps1` again.

### Credits

Each new phrase is synthesized twice per voice: once as mp3 for playback and once as
16 kHz audio for scoring. Repeats come from the cache in `.cache/` and cost nothing.

### Without an ElevenLabs key

Everything still works. The free gTTS voice speaks and scores the reference, and the
page says so in a banner. You lose the four-voice picker and the *Hear the sounds only*
button.

## Testing it

### In the browser

1. Open http://127.0.0.1:8077 and click **use a sample paragraph**, or paste your own
   text.
2. Drag across a phrase and click the **Practise…** pill.
3. Click **Hear it** or **Slowly**.
4. Click **Record** and read the phrase (Space stops), or click **Upload** and pick a
   file from `samples/`.

### Sample recordings

The `samples/` folder holds readings that cover the score range. Select the matching
phrase before uploading:

| File | Phrase to select | What to expect |
|---|---|---|
| `good-thorough.wav` | Thorough preparation rarely feels urgent. | high, around 95 |
| `good-hello.wav` | Hello, how are you today? | good, with a British-accent reading |
| `wrong-words.wav` | Hello, how are you today? | around 50, `hello` and `how` flagged |
| `robotic.wav` | Hello, how are you today? | very low; espeak's formant voice |

Scores shift a few points between voices, because Voice match measures distance from
whichever voice is selected. `samples/make_samples.py` regenerates the files.

### From the command line

`check.py` runs the same pipeline against a file, using the same reference voice as the
web app:

```powershell
.\.venv\Scripts\python.exe check.py samples\wrong-words.wav "Hello, how are you today?"
.\.venv\Scripts\python.exe check.py my-recording.mp3 "the text it should say"
.\.venv\Scripts\python.exe check.py my-recording.webm "Hello there" --json
.\.venv\Scripts\python.exe check.py --sample          # synthesizes its own reading
```

It prints the score, the three terms, the transcript and the per-word and per-sound
diff. Any format ffmpeg reads works: wav, mp3, m4a, ogg, webm/opus.

## The voices

| Label | ElevenLabs voice | Measured median pitch |
|---|---|---|
| Lower Male Voice | Brian | 88 Hz |
| Higher Male Voice | Eric | 171 Hz |
| Lower Female Voice | Matilda | 199 Hz |
| Higher Female Voice | Bella | 220 Hz |

All four are American English, matching the sound targets the scorer uses. They're
ElevenLabs stock voices, so the ids are the same on every account. The list lives in
`VOICES` in `backend/settings.py`.

The voice you pick is also the one you're scored against. That keeps what you hear and
what you're measured against identical.

## Calibrating the score

The Voice match term maps "distance from the reference" onto 0–100 using a constant,
`acoustic_good`, that OpenPronounce measured with gTTS as the reference. An ElevenLabs
voice sits slightly differently, which makes that term a little generous or harsh for
everyone.

Re-measure it for your voice:

```powershell
.\.venv\Scripts\python.exe calibrate.py
```

It reads a few sentences in two voices, prints the median distance between them and
the line to paste into `.env`:

```ini
ACOUSTIC_GOOD=6.4
```

This step is optional. The Sounds and Words terms (70% of the score) don't depend
on it.

## Configuration

All optional, all in `.env`. `.env.example` has the annotated list.

| Variable | Default | |
|---|---|---|
| `ELEVENLABS_API_KEY` | none | without it, gTTS is the reference voice |
| `ELEVENLABS_VOICE_ID` | Lower Male Voice | starting voice; the header picker switches live |
| `ELEVENLABS_MODEL_ID` | `eleven_multilingual_v2` | the speaking voice; `eleven_flash_v2_5` uses half the credits |
| `ELEVENLABS_PHONEME_MODEL_ID` | `eleven_flash_v2` | only some models honour `<phoneme>` tags |
| `ELEVENLABS_SLOW_SPEED` | `0.7` | the *Slowly* button (ElevenLabs accepts 0.7–1.2) |
| `PRONOUNCE_HOST` / `PRONOUNCE_PORT` | `127.0.0.1` / `8077` | |
| `ACOUSTIC_GOOD` | OpenPronounce's | see calibration above |
| `OPENPRONOUNCE_DEVICE` | auto | `cpu`, `cuda`, `mps` |
| `OPENPRONOUNCE_PHONEME_MODEL` | espeak model | `off` skips phone recognition |

## API

The browser is one client; everything is also reachable directly. Interactive docs are
at `/docs`.

| | |
|---|---|
| `GET /api/health` | model load progress and any missing system dependency |
| `GET /api/config` | reference voice, model, limits |
| `GET /api/voices` | the four voices, with the selected one |
| `POST /api/phonemes` | `text` → per-word IPA |
| `GET /api/tts` | `text`, `speed`, `voice_id`, `ipa` → audio |
| `GET /api/reference` | `text`, `voice_id` → the 16 kHz wav the score is measured against |
| `POST /api/analyze` | `file`, `expected_text`, `voice_id` → the full assessment |

```bash
curl -F file=@attempt.webm -F expected_text="Hello, I am a developer" \
     http://127.0.0.1:8077/api/analyze
```

## Layout

```
backend/
  app.py          HTTP API, static host, startup and model warm-up
  scoring.py      OpenPronounce wrapper: score breakdown, per-word join, word scoring
  elevenlabs.py   TTS client, the four-voice list, registration as an OpenPronounce voice
  settings.py     .env and environment → one Settings object; the VOICES list
  bootstrap.py    finds libespeak-ng and ffmpeg before OpenPronounce is imported
frontend/
  index.html      page structure
  styles.css      design tokens, light and dark
  app.js          selection, recording, upload, results
samples/          test recordings and make_samples.py
check.py          score a file from the command line
calibrate.py      re-measure acoustic_good for your voice
setup.ps1 / run.ps1
```

### How ElevenLabs ends up inside the scoring

`openpronounce.tts.BACKENDS` maps a backend name to a
`(synthesize(text, lang, voice) -> (waveform, sample_rate), default_voice(lang))`
pair. `elevenlabs.register_openpronounce_backend` adds an entry, and
`OPENPRONOUNCE_TTS=elevenlabs` makes `compare_audio_with_text` use it.

## System dependencies

`setup.ps1` installs these. To do it by hand:

| | Why | Windows | macOS | Debian/Ubuntu |
|---|---|---|---|---|
| **espeak-ng** | turns text into IPA | `winget install eSpeak-NG.eSpeak-NG` | `brew install espeak-ng` | `sudo apt install espeak-ng` |
| **ffmpeg** | decodes browser recordings; slows the gTTS voice | `winget install Gyan.FFmpeg` | `brew install ffmpeg` | `sudo apt install ffmpeg` |

`backend/bootstrap.py` finds `libespeak-ng` in the usual install locations and sets
`PHONEMIZER_ESPEAK_LIBRARY` itself. If it's installed somewhere unusual, set that
variable yourself.

## Notes

* Microphone capture turns **off** echo cancellation and noise suppression, because
  both reshape the sound the phone recognizer reads. Automatic gain stays on.
* Analyses run one at a time; on CPU, two at once is slower than two in sequence.
* Recordings are written to a temp file, scored and deleted. Only the synthesized
  reference audio is kept, in `.cache/`.
* Selections are capped at 400 characters. A sentence or two scores far more usefully
  than a paragraph.

## License

OpenPronounce is MIT. ElevenLabs usage is subject to their terms.
>>>>>>> Stashed changes
