"""Signal checks, not a pronunciation or fluency grade. Thresholds are heuristics."""
import numpy as np


def recording_quality(waveform, sample_rate):
    samples = np.asarray(waveform, dtype=float).reshape(-1)
    samples = samples[np.isfinite(samples)]
    duration = len(samples) / sample_rate
    rms = float(np.sqrt(np.mean(samples ** 2))) if len(samples) else 0.0
    clipped = float(np.mean(np.abs(samples) >= 0.99)) if len(samples) else 0.0
    warnings = []
    if rms < 0.01:
        warnings.append('Your recording is quiet. Move closer to the microphone and try again.')
    if clipped >= 0.01:
        warnings.append('The recording may be distorted. Move a little farther from the microphone or lower its input level.')
    return {
        'duration_seconds': round(duration, 2),
        'rms_dbfs': round(20 * np.log10(max(rms, 1e-8)), 1),
        'clipped_percent': round(clipped * 100, 2),
        'warnings': warnings,
        'label': 'Check your recording' if warnings else 'No level issues detected',
        'note': 'Level checks cannot detect every source of background noise or recognition error. They do not change your pronunciation score.',
    }
