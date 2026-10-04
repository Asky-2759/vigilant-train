import unittest
from backend.guidance import practice_guidance


class GuidanceTests(unittest.TestCase):
    def test_wrong_phrase_is_reviewed_before_individual_sounds(self):
        result = practice_guidance([{'word': 'good', 'status': 'wrong', 'confidence': 1, 'position': 0}], {'warnings': []}, 1)
        self.assertIsNone(result['position'])
        self.assertIn('transcript', result['message'])

    def test_recording_problem_takes_priority_over_sound_flags(self):
        result = practice_guidance([{'word': 'three', 'status': 'wrong', 'confidence': .9, 'position': 0}], {'warnings': ['Too quiet']})
        self.assertIsNone(result['position'])
        self.assertEqual(result['message'], 'Too quiet')

    def test_uncertain_flag_is_not_presented_as_a_mistake(self):
        result = practice_guidance([{'word': 'three', 'status': 'close', 'confidence': .2, 'position': 0}], {'warnings': []})
        self.assertIn('uncertain', result['message'])

    def test_strongest_flag_is_prioritized(self):
        words = [{'word': 'a', 'status': 'close', 'confidence': .2, 'position': 0}, {'word': 'tree', 'status': 'wrong', 'confidence': .8, 'position': 1}]
        self.assertEqual(practice_guidance(words, {'warnings': []})['position'], 1)

    def test_no_flags_offers_new_context(self):
        self.assertIsNone(practice_guidance([], {'warnings': []})['position'])
