import librosa
import soundfile as sf
import noisereduce as nr
import numpy as np
from scipy.signal import butter, lfilter

def sharpen_audio_file(input_path, output_path=None, target_sr=16000):
    """
    Applies high-pass filtering, spectral noise reduction, and peak normalization 
    to an audio file to optimize it for speech-to-text engines.
    
    If output_path is None, it overwrites the input file.
    """
    if output_path is None:
        output_path = input_path
        
    try:
        # 1. Load audio and resample to target sample rate (default 16 kHz mono)
        audio, sr = librosa.load(input_path, sr=target_sr, mono=True)
        
        # 2. High-pass filter (removes low-frequency rumbles below 85 Hz like AC hums/mic thuds)
        nyq = 0.5 * sr
        b, a = butter(5, 85 / nyq, btype='high')
        filtered = lfilter(b, a, audio)
        
        # 3. Spectral noise reduction (removes steady background noise)
        reduced = nr.reduce_noise(y=filtered, sr=sr, prop_decrease=0.8)
        
        # 4. Peak normalization (brings the peak volume to optimal range)
        max_val = np.max(np.abs(reduced))
        if max_val > 0:
            normalized = reduced / max_val
        else:
            normalized = reduced
            
        # 5. Save the cleaned audio
        sf.write(output_path, normalized, sr)
        return output_path
    except Exception as e:
        print(f"Error enhancing audio file {input_path}: {e}")
        return None