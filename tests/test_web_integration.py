"""API contract tests without model downloads. Run: python -m unittest discover -s tests"""
import os
import tempfile
import subprocess
import unittest
import wave
from unittest.mock import patch

from fastapi.testclient import TestClient
from backend import app as web


class WebIntegrationTests(unittest.TestCase):
    def test_decoder_rejects_long_audio_and_removes_partial_file(self):
        outputs = []
        def decode(args, **kwargs):
            self.assertEqual(kwargs['timeout'], 30)
            self.assertIn('61', args)
            outputs.append(args[-1])
            with wave.open(args[-1], 'wb') as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(16000)
                audio.writeframes(b'\x00\x00' * (61 * 16000))
        with patch.object(web.subprocess, 'run', side_effect=decode):
            with self.assertRaises(web.scoring.AnalysisError):
                web._to_wav('input.mp3')
        self.assertFalse(os.path.exists(outputs[0]))

    def test_decoder_failure_removes_partial_file(self):
        outputs = []
        def fail(args, **kwargs):
            outputs.append(args[-1])
            raise subprocess.CalledProcessError(1, args)
        with patch.object(web.subprocess, 'run', side_effect=fail):
            with self.assertRaises(web.scoring.AnalysisError):
                web._to_wav('invalid.mp3')
        self.assertFalse(os.path.exists(outputs[0]))

    def setUp(self):
        self.client = TestClient(web.app)
        web._state.update(models="ready", native={"missing": []}, error=None)

    def test_frontend_build_is_served(self):
        self.assertEqual(self.client.get("/").status_code, 200)
        self.assertIn("/assets/", self.client.get("/").text)

    def test_upload_analysis_and_cleanup(self):
        paths = []
        def convert(source):
            self.assertTrue(os.path.exists(source))
            paths.append(source)
            fd, path = tempfile.mkstemp(suffix=".wav")
            os.close(fd)
            paths.append(path)
            return path
        payload = {"score": 80, "transcribe": "hello", "heard_ipa": "h", "words": []}
        with patch.object(web, "_to_wav", side_effect=convert), patch.object(web.scoring, "analyze", return_value=payload):
            response = self.client.post("/api/analyze", data={"expected_text": "hello"}, files={"file": ("take.webm", b"audio", "audio/webm")})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), payload)
        self.assertTrue(all(not os.path.exists(path) for path in paths))

    def test_analysis_failure_also_cleans_upload(self):
        paths = []
        def fail(source):
            paths.append(source)
            raise web.scoring.AnalysisError("Invalid recording")
        with patch.object(web, "_to_wav", side_effect=fail):
            response = self.client.post("/api/analyze", data={"expected_text": "hello"}, files={"file": ("take.webm", b"audio")})
        self.assertEqual(response.status_code, 422)
        self.assertTrue(all(not os.path.exists(path) for path in paths))

    def test_empty_upload_rejected(self):
        response = self.client.post("/api/analyze", data={"expected_text": "hello"}, files={"file": ("take.webm", b"")})
        self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
