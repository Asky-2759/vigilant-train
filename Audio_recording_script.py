import sounddevice as sd
import numpy as np
from scipy.io.wavfile import write

RATE = 16000
CHANNELS = 1

# Adjust these if necessary
SILENCE_THRESHOLD = 500
SILENCE_DURATION = 3.0
MAX_RECORDING_TIME = 30

BLOCK_DURATION = 0.1
BLOCK_SIZE = int(RATE * BLOCK_DURATION)

recorded_blocks = []
started_speaking = False
silence_time = 0.0
total_time = 0.0

print("Listening...")
print("Start speaking whenever you're ready.")

try:
    with sd.InputStream(
        samplerate=RATE,
        channels=CHANNELS,
        dtype="int16",
        blocksize=BLOCK_SIZE
    ) as stream:

        while total_time < MAX_RECORDING_TIME:

            audio, overflowed = stream.read(BLOCK_SIZE)

            # Measure how loud this block is
            volume = np.sqrt(
                np.mean(audio.astype(np.float32) ** 2)
            )

            if not started_speaking:
                # Wait until speech begins
                if volume > SILENCE_THRESHOLD:
                    started_speaking = True
                    print("🎤 Speech detected — recording!")
                    recorded_blocks.append(audio.copy())

            else:
                recorded_blocks.append(audio.copy())

                if volume < SILENCE_THRESHOLD:
                    silence_time += BLOCK_DURATION
                else:
                    silence_time = 0.0

                # Stop after enough continuous silence
                if silence_time >= SILENCE_DURATION:
                    print("Silence detected — stopping.")
                    break

            total_time += BLOCK_DURATION

    if not started_speaking:
        print("No speech detected.")

    else:
        recording = np.concatenate(recorded_blocks, axis=0)

        write("mic_test.wav", RATE, recording)

        print("Recording completed!")
        print("Saved as mic_test.wav")

except Exception as e:
    print("\nERROR:")
    print(type(e).__name__)
    print(e)

input("\nPress ENTER to close...")