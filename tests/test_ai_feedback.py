import unittest
from dataclasses import replace
from unittest.mock import patch
from backend import app as web
from backend import settings
import ai_advice

class AIFeedbackTests(unittest.TestCase):
    def setUp(self):
        self.result = {'score': 72, 'words': [
            {'word': 'three', 'heard': 'tri', 'expected': 'thri', 'status': 'close'},
            {'word': 'trees', 'heard': 'trees', 'expected': 'trees', 'status': 'ok'}]}

    def test_success_uses_flagged_words_and_preserves_score(self):
        with patch.object(web, 'SETTINGS', replace(web.SETTINGS, gemini_api_key='test')), patch.object(ai_advice, 'generate_pronunciation_feedback', return_value='Try three slowly.') as generate:
            web._add_ai_feedback(self.result)
        self.assertEqual(self.result['score'], 72)
        self.assertEqual(self.result['ai_feedback'], 'Try three slowly.')
        self.assertEqual(generate.call_args.args[0], [('three','tri','thri')])

    def test_provider_failure_preserves_score(self):
        with patch.object(web, 'SETTINGS', replace(web.SETTINGS, gemini_api_key='test')), patch.object(ai_advice, 'generate_pronunciation_feedback', side_effect=TimeoutError('secret')):
            web._add_ai_feedback(self.result)
        self.assertEqual(self.result['score'], 72)
        self.assertIsNone(self.result['ai_feedback'])
        self.assertNotIn('secret', self.result['ai_feedback_error'])

    def test_no_key_and_poor_recording_skip_provider(self):
        for key, quality in [('', {}), ('test', {'warnings':['Too quiet']})]:
            with self.subTest(key=bool(key)), patch.object(web, 'SETTINGS', replace(web.SETTINGS, gemini_api_key=key)), patch.object(ai_advice, 'generate_pronunciation_feedback') as generate:
                self.result['recording_quality'] = quality
                web._add_ai_feedback(self.result)
                generate.assert_not_called()

    def test_no_flags_skips_provider(self):
        self.result['words'] = [self.result['words'][1]]
        with patch.object(web, 'SETTINGS', replace(web.SETTINGS, gemini_api_key='test')), patch.object(ai_advice, 'generate_pronunciation_feedback') as generate:
            web._add_ai_feedback(self.result)
            generate.assert_not_called()

    def test_sdk_request_is_bounded_and_plain_language(self):
        with patch('google.genai.Client') as factory:
            client = factory.return_value.__enter__.return_value
            client.models.generate_content.return_value.text = ' Try three slowly. '
            text = ai_advice.generate_pronunciation_feedback([('three','tri','thri')],api_key='test')
        self.assertEqual(text, 'Try three slowly.')
        self.assertEqual(factory.call_args.kwargs['http_options']['timeout'],20000)
        config = client.models.generate_content.call_args.kwargs['config']
        self.assertIn('no IPA', config['system_instruction'])

    def test_google_key_alias(self):
        import os
        with patch.object(settings, 'load_dotenv'), patch.dict(os.environ, {'GOOGLE_API_KEY':'test', 'GEMINI_API_KEY':''}):
            self.assertEqual(settings.load().gemini_api_key,'test')
