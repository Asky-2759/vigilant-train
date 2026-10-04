"""Record audio, recognize phones with OpenPronounce, and compare IPA.

py -3.10 practice.py             # WAV deleted after analysis, even on error
py -3.10 practice.py --keep-audio # Keep the WAV for troubleshooting
"""
import argparse
from pathlib import Path
from tempfile import TemporaryDirectory

from audio_recorder import record
from speech_to_ipa import parse_audio
from comparison import compare_pronunciation
from audio_processer import sharpen_audio_file


def run_attempt(text, mode, accent, output_dir):
    wav_path = record(mode, output_dir=output_dir)
    if wav_path is None:
        return
    # record() has closed the WAV before the recognizer opens it.
    phones = parse_audio(wav_path)
    differences = compare_pronunciation(text, phones, accent)
    print("Detected IPA:", " ".join(phones))
    print("Sequence differences (not confirmed pronunciation mistakes):")
    for kind, detected, expected in differences:
        print(f"{kind}: detected {detected!r}, expected {expected!r}")
    if not differences:
        print("No sequence differences found.")


def main():
    from backend.bootstrap import configure
    configure()
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep-audio", action="store_true")
    args = parser.parse_args()
    text = input("Sentence to practise: ").strip()
    if not text:
        raise ValueError("Enter a target sentence.")
    mode = input("1 = automatic, 2 = manual: ").strip()
    accent = input("Accent (US or British; default US): ").strip() or "US"
    
    if args.keep_audio:
        directory = Path(__file__).resolve().parent / "recordings"
        directory.mkdir(exist_ok=True)
        
        # Run attempt (which records audio into the directory)
        run_attempt(text, mode, accent, directory)
        
        # Sharpen any generated audio files in the directory
        for wav_file in directory.glob("*.wav"):
            print(f"Sharpening: {wav_file.name}")
            sharpen_audio_file(wav_file)
            
    else:
        with TemporaryDirectory(prefix="pronunciation_") as directory:
            dir_path = Path(directory)
            
            # Run attempt
            run_attempt(text, mode, accent, dir_path)
            
            # Sharpen any generated audio files before temporary cleanup
            for wav_file in dir_path.glob("*.wav"):
                sharpen_audio_file(wav_file)


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print("\nStopped.")
    except Exception as error:
        print(f"{type(error).__name__}: {error}")
