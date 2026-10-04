"""Score an audio file against the text it should contain, from the command line.

The whole pipeline the web app uses, without a browser or a microphone -- the
quickest way to confirm an install works, or to score recordings in bulk.

    python check.py recording.wav "Hello, I am a developer"
    python check.py recording.webm "Hello there" --json
    python check.py --sample                    # synthesize a reading and score it

Any format ffmpeg can read works: wav, mp3, m4a, ogg, and the webm/opus the
browser records.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from backend import scoring, settings as settings_module

BAR_WIDTH = 28

# The report is full of IPA, and a Windows console defaults to cp1252, which cannot
# encode a schwa. Without this the whole run dies on its first print.
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("audio", nargs="?", help="recording to score")
    parser.add_argument("text", nargs="?", help="the text it should contain")
    parser.add_argument("--json", action="store_true", dest="as_json",
                        help="print the raw analysis instead of the report")
    parser.add_argument("--sample", action="store_true",
                        help="synthesize a reading with espeak-ng and score that, to smoke-test the install")
    args = parser.parse_args()

    settings = settings_module.load()

    print("Loading models (first run downloads ~2.4 GB)...", file=sys.stderr)
    report = scoring.init(settings)
    if report["missing"]:
        print(f"\nMissing system dependencies: {', '.join(report['missing'])}", file=sys.stderr)
        for name, hint in report["hints"].items():
            print(f"  {name}: {hint}", file=sys.stderr)
        return 1

    # Score against the same reference voice the web app uses, or the numbers
    # here and in the browser would disagree for the same recording.
    voice_id = None
    if settings.elevenlabs_enabled:
        from backend import elevenlabs as elevenlabs_module

        client = elevenlabs_module.ElevenLabs(settings)
        elevenlabs_module.register_openpronounce_backend(client)
        voice_id = client.default_voice_id()
        print(f"Reference voice: {client.voice_name(voice_id)} (ElevenLabs)", file=sys.stderr)
    os.environ["OPENPRONOUNCE_TTS"] = settings.reference_backend

    temporary = None
    if args.sample:
        text = args.text or "Thorough preparation rarely feels urgent."
        temporary = _espeak_wav(text)
        if temporary is None:
            return 1
        audio_path = temporary
        print(f"Synthesized a reading of {text!r} with espeak-ng\n", file=sys.stderr)
    else:
        if not args.audio or not args.text:
            parser.error("give an audio file and the expected text, or use --sample")
        audio_path = Path(args.audio)
        if not audio_path.is_file():
            print(f"No such file: {audio_path}", file=sys.stderr)
            return 1
        text = args.text

    try:
        result = scoring.analyze(str(audio_path), text, voice_id)
    except scoring.AnalysisError as e:
        print(f"Cannot score that recording: {e}", file=sys.stderr)
        return 1
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)

    if args.as_json:
        json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
        print()
    else:
        _report(result, text)
    return 0


def _report(result, text):
    band = result["band"]
    print(f"\n  {text}")
    print(f"  {'-' * min(len(text), 72)}\n")
    print(f"  Score        {result['score']:.1f} / 100   ({band['label']})")
    print(f"  {_bar(result['score'])}\n")

    for term in result["breakdown"]:
        print(f"  {term['label']:<12} {term['value']:5.1f}  {_bar(term['value'], 16)}  "
              f"{term['detail']}  [{term['weight']:.0%}]")

    print(f"\n  Heard        {(result.get('transcribe') or '').strip().lower() or '-'}")
    print(f"  Sounds       {result.get('heard_ipa') or '-'}")
    expected = " ".join(word["expected"] for word in result["words"] if word["expected"])
    print(f"  Expected     {expected or '-'}")

    flagged = [word for word in result["words"] if word["status"] != "ok"]
    print(f"\n  Words        {len(result['words']) - len(flagged)}/{len(result['words'])} clear")
    for word in flagged:
        print(f"    {word['status']:>5}  {word['word']:<16} expected /{word['expected']}/  "
              f"heard /{word['heard'] or '-'}/  ({word['confidence']:.0%} sure)")
        for phone in word["phones"]:
            if phone["confidence"] <= 0:
                continue
            heard = phone["heard"] or "nothing"
            print(f"             {phone['expected']:<4} -> {heard:<6} ({phone['confidence']:.0%})")

    if not result["has_reference"]:
        print(f"\n  Note: no reference voice ({result.get('reference_error')}), so the acoustic "
              "term was left out and the other two were re-weighted.")
    print()


def _bar(value, width=BAR_WIDTH):
    filled = int(round(max(0.0, min(100.0, value)) / 100 * width))
    return f"[{'#' * filled}{'.' * (width - filled)}]"


def _espeak_wav(text):
    """Render ``text`` with the espeak-ng CLI -- a stand-in recording for smoke tests.

    Deliberately a different synthesizer from the reference voice, so the score
    reflects a real comparison rather than a file against itself.
    """
    espeak = shutil.which("espeak-ng") or shutil.which("espeak")
    if espeak is None:
        espeak_dir = Path(r"C:\Program Files\eSpeak NG\espeak-ng.exe")
        if espeak_dir.is_file():
            espeak = str(espeak_dir)
    if espeak is None:
        print("espeak-ng is not on PATH, so --sample cannot synthesize a reading.", file=sys.stderr)
        return None

    # Close the handle but keep the file: espeak -w overwrites it in place, and on
    # Windows an open file cannot be unlinked first.
    handle, path = tempfile.mkstemp(suffix=".wav", prefix="pronounce-sample-")
    os.close(handle)

    result = subprocess.run([espeak, "-v", "en-us", "-s", "150", "-w", path, text], capture_output=True)
    if result.returncode != 0 or not Path(path).is_file():
        print(f"espeak-ng failed: {result.stderr.decode('utf-8', 'replace').strip()}", file=sys.stderr)
        return None
    return Path(path)


if __name__ == "__main__":
    raise SystemExit(main())
