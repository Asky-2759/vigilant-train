"""Regenerate the sample recordings in this folder.

The point of the samples is to exercise the scorer across its range without
anybody needing a microphone, so each one is deliberately a different kind of
reading:

* ``good-*``      -- the right words in a natural voice, read with a *British*
                     accent while the reference voice is American. A real
                     different-speaker comparison, which is what a learner is.
* ``wrong-words`` -- a natural voice saying the wrong words ("hell no who are
                     you to day"), so word and phone errors both appear.
* ``robotic``     -- espeak-ng's formant synthesis. Intelligible to a human,
                     nothing like speech to Wav2Vec2, so it floors the score.

    python samples/make_samples.py
"""

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent

#: name -> (text, gTTS language, Google domain = accent)
GTTS_SAMPLES = {
    "good-hello": ("Hello, how are you today?", "en", "co.uk"),
    "good-thorough": ("Thorough preparation rarely feels urgent.", "en", "co.uk"),
    "wrong-words": ("Hell no, who are you to day?", "en", "co.uk"),
}

#: name -> (text, espeak voice)
ESPEAK_SAMPLES = {
    "robotic": ("Hello, how are you today?", "en-us"),
}

ESPEAK_FALLBACK = Path(r"C:\Program Files\eSpeak NG\espeak-ng.exe")


def to_wav(source, destination):
    """Transcode to 16 kHz mono wav, the format the scorer works in."""
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(source), "-ac", "1", "-ar", "16000", str(destination)],
        check=True,
    )


def main():
    from gtts import gTTS

    for name, (text, lang, tld) in GTTS_SAMPLES.items():
        # mkstemp hands back an open descriptor, and Windows will not unlink a file
        # that still has one.
        descriptor, path = tempfile.mkstemp(suffix=".mp3", prefix="sample-")
        os.close(descriptor)
        handle = Path(path)
        gTTS(text=text, lang=lang, tld=tld, slow=False).save(str(handle))
        to_wav(handle, HERE / f"{name}.wav")
        handle.unlink(missing_ok=True)
        print(f"  {name}.wav  ({tld})  {text!r}")

    espeak = shutil.which("espeak-ng") or shutil.which("espeak")
    if espeak is None and ESPEAK_FALLBACK.is_file():
        espeak = str(ESPEAK_FALLBACK)
    if espeak is None:
        print("  (skipped the espeak sample: espeak-ng is not on PATH)", file=sys.stderr)
        return 0

    for name, (text, voice) in ESPEAK_SAMPLES.items():
        target = HERE / f"{name}.wav"
        subprocess.run([espeak, "-v", voice, "-s", "150", "-w", str(target), text], check=True)
        print(f"  {name}.wav  (espeak {voice})  {text!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
