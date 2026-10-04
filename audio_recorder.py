"""Windows microphone recorder: automatic or Enter-controlled, 16-kHz mono WAV.

Install dependencies: py -3.10 -m pip install sounddevice numpy scipy
Run: py -3.10 audio_recorder.py
"""

from collections import deque
from pathlib import Path
import math
import msvcrt
import time

import numpy as np
import sounddevice as sd
from scipy.io.wavfile import write


RATE = 16000
CHANNELS = 1
DEVICE = None  # Default input. Set an input device index if needed.
SILENCE_THRESHOLD = 500  # RMS amplitude on int16 samples; not a speech classifier.
SILENCE_DURATION = 3.0
MAX_RECORDING_TIME = 30.0  # Starts when recording begins, not while waiting.
WAIT_FOR_SPEECH_TIMEOUT = 30.0
PRE_ROLL_DURATION = 0.3  # Preserve sound immediately before the trigger.
BLOCK_DURATION = 0.1
BLOCK_SIZE = int(RATE * BLOCK_DURATION)
OUTPUT_DIR = Path(__file__).resolve().parent / "recordings"


def enter_pressed():
    """Poll Windows console without blocking microphone capture."""
    pressed = False
    while msvcrt.kbhit():
        key = msvcrt.getwch()
        if key == "\x03":
            raise KeyboardInterrupt
        if key in ("\x00", "\xe0"):
            msvcrt.getwch()  # Consume special-key scan code.
        elif key in ("\r", "\n"):
            pressed = True
    return pressed


def record(mode, output_dir=None):
    if mode not in ("1", "2"):
        raise ValueError("Mode must be '1' (automatic) or '2' (manual).")
    automatic = mode == "1"
    blocks = []
    pre_roll = deque(maxlen=math.ceil(PRE_ROLL_DURATION / BLOCK_DURATION))
    started = not automatic
    silence_samples = 0
    captured_samples = 0
    overflow_count = 0
    max_samples = int(MAX_RECORDING_TIME * RATE)

    sd.check_input_settings(device=DEVICE, samplerate=RATE,
                            channels=CHANNELS, dtype="int16")
    input("Press ENTER to arm automatic recording..." if automatic
          else "Press ENTER to START recording...")
    print("Listening for sound; ENTER cancels/stops." if automatic
          else "Recording. Press ENTER to STOP.")
    print("Ctrl+C also stops and saves any captured audio.")

    try:
        with sd.InputStream(samplerate=RATE, channels=CHANNELS,
                            dtype="int16", blocksize=BLOCK_SIZE,
                            device=DEVICE) as stream:
            waiting_since = time.monotonic()
            while True:
                if enter_pressed():
                    break

                audio, overflowed = stream.read(BLOCK_SIZE)
                overflow_count += int(overflowed)
                volume = float(np.sqrt(np.mean(audio.astype(np.float32) ** 2)))
                print(f"\r{'Recording' if started else 'Waiting'} | RMS {volume:7.1f}",
                      end="", flush=True)

                if not started:
                    if volume >= SILENCE_THRESHOLD:
                        started = True
                        blocks.extend(pre_roll)
                        captured_samples = sum(len(block) for block in blocks)
                        print("\nSound detected -- recording!")
                    else:
                        pre_roll.append(audio.copy())
                        if time.monotonic() - waiting_since >= WAIT_FOR_SPEECH_TIMEOUT:
                            print("\nTimed out waiting for sound.")
                            break
                        continue

                # Enforce the duration limit, including the short pre-roll.
                chunk = audio[:max_samples - captured_samples].copy()
                blocks.append(chunk)
                captured_samples += len(chunk)

                if automatic:
                    silence_samples = (silence_samples + len(chunk)
                                       if volume < SILENCE_THRESHOLD else 0)
                    if silence_samples >= int(SILENCE_DURATION * RATE):
                        print("\nSilence detected -- stopping.")
                        break

                if captured_samples >= max_samples:
                    print("\nMaximum recording duration reached.")
                    break
    except KeyboardInterrupt:
        print("\nStopped by user.")
    except sd.PortAudioError:
        print("\nAudio device error; this recording was not saved. Please retry.")
        raise
    finally:
        print()

    if not blocks:
        print("No recording captured; no file saved.")
        return None

    recording = np.concatenate(blocks, axis=0)
    destination = Path(output_dir) if output_dir is not None else OUTPUT_DIR
    destination.mkdir(parents=True, exist_ok=True)
    # Exclusive creation prevents accidental overwriting of previous takes.
    path = destination / f"take_{time.time_ns()}.wav"
    with path.open("xb") as wav_file:
        write(wav_file, RATE, recording)
    print(f"Saved: {path}")
    print(f"Duration: {len(recording) / RATE:.1f}s | 16 kHz | mono | 16-bit PCM")
    if overflow_count:
        print(f"WARNING: {overflow_count} audio buffer overflow(s). "
              "Samples may be missing; record another take for analysis.")
    if np.max(np.abs(recording.astype(np.int32))) >= 32760:
        print("WARNING: Audio reached full scale and may be clipped. "
              "Reduce microphone gain or move slightly farther away.")
    return path


def main():
    print("Microphone -> WAV recorder")
    while True:
        print("\n1 - Automatic: start on sound, stop after silence")
        print("2 - Manual: ENTER starts and stops")
        print("D - List audio devices | Q - Quit")
        choice = input("Choose a mode: ").strip().lower()
        if choice == "q":
            return
        if choice == "d":
            print(sd.query_devices())
            print("Default input/output:", sd.default.device)
        elif choice in ("1", "2"):
            try:
                record(choice)
            except (sd.PortAudioError, OSError, ValueError) as error:
                print(f"ERROR: {type(error).__name__}: {error}")
                print("Check your Windows input device and microphone permissions.")
        else:
            print("Choose 1, 2, D, or Q.")


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, EOFError):
        print("\nGoodbye.")
