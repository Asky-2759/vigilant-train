import unittest
import numpy as np
from backend.quality import recording_quality


class QualityTests(unittest.TestCase):
    def test_quiet_signal_gets_actionable_warning(self):
        result = recording_quality(np.zeros(16000), 16000)
        self.assertEqual(result['duration_seconds'], 1)
        self.assertIn('quiet', result['warnings'][0])
        self.assertTrue(np.isfinite(result['rms_dbfs']))

    def test_clipping_is_reported_without_pronunciation_grade(self):
        result = recording_quality(np.ones(16000), 16000)
        self.assertEqual(result['clipped_percent'], 100)
        self.assertIn('distorted', result['warnings'][0])
        self.assertNotIn('score', result)

    def test_normal_tone_has_no_level_warning(self):
        tone = .1 * np.sin(2 * np.pi * 220 * np.arange(16000) / 16000)
        self.assertEqual(recording_quality(tone, 16000)['warnings'], [])
