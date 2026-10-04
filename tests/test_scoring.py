import unittest
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np
from backend import scoring


class ScoringTests(unittest.TestCase):
    def test_accepted_variant_has_no_sound_penalty(self):
        reports = [{'expected': ['a', 'b'], 'actual': ['c'], 'weighted_edits': 0}]
        with patch.object(scoring, '_phones', SimpleNamespace(_word_reports=lambda *_: reports)):
            rate = scoring.variant_aware_phone_rate('word', {'expected_phones': [['a','b']], 'heard_phones': ['c']})
        self.assertEqual(rate, 0)

    def test_missing_word_is_not_discounted(self):
        reports = [{'expected': ['a', 'b'], 'actual': [], 'weighted_edits': 1.5}]
        with patch.object(scoring, '_phones', SimpleNamespace(_word_reports=lambda *_: reports)):
            rate = scoring.variant_aware_phone_rate('word', {'expected_phones': [['a','b']], 'heard_phones': []})
        self.assertEqual(rate, 1)

    def test_unaligned_extra_phone_falls_back_instead_of_disappearing(self):
        reports = [{'expected': ['a'], 'actual': ['a'], 'weighted_edits': 0}]
        with patch.object(scoring, '_phones', SimpleNamespace(_word_reports=lambda *_: reports)):
            rate = scoring.variant_aware_phone_rate('word', {'expected_phones': [['a']], 'heard_phones': ['a','b']})
        self.assertIsNone(rate)

    def test_spacing_does_not_punish_same_words(self):
        self.assertEqual(scoring.boundary_tolerant_wer('today everyone', 'TO DAY EVERY ONE'), 0)

    def test_missing_words_are_still_counted(self):
        self.assertEqual(scoring.boundary_tolerant_wer('three free trees', 'three trees'), 1 / 3)

    def test_empty_transcript_is_not_a_perfect_match(self):
        self.assertEqual(scoring.boundary_tolerant_wer('three free trees', ''), 1)

    def test_reference_free_score_and_weights_agree(self):
        speech = SimpleNamespace(SCORE_WEIGHTS={'phonemes': .4, 'words': .3, 'acoustic': .3})
        differences = {'phoneme_error_rate': .2, 'word_error_rate': .5}
        with patch.object(scoring, '_speech', speech):
            score = scoring._total_score(None, differences)
            parts = scoring._breakdown({'acoustic_distance': None}, differences)
        self.assertAlmostEqual(sum(p['weight'] for p in parts), 1)
        self.assertAlmostEqual(score, sum(p['weight'] * p['value'] for p in parts), places=2)

    def test_unknown_heard_word_does_not_echo_expected(self):
        phones = SimpleNamespace(get_expected_phones=lambda *_: (['hello'], [['h','e']]))
        with patch.object(scoring, '_phones', phones):
            words = scoring._word_verdicts('hello', {}, None)
        self.assertEqual(words[0]['heard'], '')

    def test_nonfinite_audio_is_rejected(self):
        with self.assertRaises(scoring.AnalysisError):
            scoring._check_recording(np.array([float('nan')]))

