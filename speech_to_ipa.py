"""OpenPronounce audio-to-IPA adapter for 16-kHz mono PCM WAV recordings.

Uses the phone recognizer only; does not generate reference speech, recognize
words, or run the full assessment pipeline. OpenPronounce caches its phone model
within the Python process. The first call downloads/loads model weights.
"""
from pathlib import Path
import wave


def recognize_ipa(wav_path: str):
    """Return unnormalized IPA tokens for our own comparator to segment.

    normalize=False avoids applying OpenPronounce's English sound mergers only
    to the detected side while leaving our comparator's expected side unchanged.
    """
    import numpy as np
    try:
        from openpronounce import transcribe_phones
    except ImportError as error:
        raise RuntimeError(
            "Install/update OpenPronounce in this Python environment: "
            "py -3.10 -m pip install --upgrade openpronounce"
        ) from error

    # Our recorder already produces the required format: decode directly,
    # avoiding an ffmpeg subprocess for these WAV files.
    with wave.open(wav_path, "rb") as wav:
        pcm = wav.readframes(wav.getnframes())
    waveform = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    print("Recognizing sounds with OpenPronounce (first use may download the model)...")
    return transcribe_phones(waveform, sampling_rate=16000,
                             normalize=False, lang="en")


def parse_audio(wav_path, recognizer=None) -> list[str]:
    from comparison import segment_ipa
    path = Path(wav_path).resolve(strict=True)
    with wave.open(str(path), "rb") as wav:
        if (wav.getframerate(), wav.getnchannels(), wav.getsampwidth()) != (16000, 1, 2):
            raise ValueError("Expected a 16-kHz, mono, 16-bit PCM WAV.")
        if wav.getnframes() == 0:
            raise ValueError("Audio file is empty.")
    raw_ipa = (recognizer or recognize_ipa)(str(path))
    phones = segment_ipa(raw_ipa)
    if not phones:
        raise ValueError("No phonemes detected.")
    return phones


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="WAV -> detected IPA sounds")
    parser.add_argument("wav_path")
    args = parser.parse_args()
    print("Detected IPA:", " ".join(parse_audio(args.wav_path)))
