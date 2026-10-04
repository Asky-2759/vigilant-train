import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
from backend import app as web
from backend.coach import CoachRequest, script
from backend.elevenlabs import ElevenLabsError

class CoachTests(unittest.TestCase):
    def test_quality_takes_priority_over_pronunciation(self):
        text, spoken = script(CoachRequest(warning='Try a quieter room.', guidance='Practise tree.', playful=False))
        self.assertIn('quieter room', text)
        self.assertNotIn('Practise tree', text)
        self.assertNotIn('gymnastics', text)
        self.assertIn('[warmly]', spoken)

    def test_text_cannot_inject_audio_tags(self):
        text, spoken = script(CoachRequest(guidance='Say [shouts] <voice> tree'))
        self.assertNotIn('[shouts]', spoken)
        self.assertNotIn('<voice>', text)

    def test_no_key_keeps_written_coaching(self):
        with patch.object(web, '_client', None):
            response = TestClient(web.app).post('/api/coach', json={'style': 'russian'})
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()['audio'])
        self.assertTrue(response.json()['transcript'])

    def test_failure_does_not_expose_provider_details(self):
        from unittest.mock import Mock
        client = Mock()
        client.voices.return_value = []
        client.synthesize.side_effect = ElevenLabsError('private provider detail')
        with patch.object(web, '_client', client):
            response = TestClient(web.app).post('/api/coach', json={})
        self.assertNotIn('private provider detail', response.text)
        self.assertTrue(response.json()['transcript'])

    def test_invalid_style_and_oversized_text_are_rejected(self):
        client = TestClient(web.app)
        for payload in ({'style':'invalid'}, {'guidance':'x'*601}):
            self.assertEqual(client.post('/api/coach',json=payload).status_code,422)
