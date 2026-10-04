"""API contract tests without model downloads. Run: python -m unittest discover -s tests"""
import os
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from backend import app as web


class WebIntegrationTests(unittest.TestCase):
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
        with patch.object(web, "_to_wav", side_effect=convert), patch.object(
            web.scoring, "analyze", return_value=payload
        ) as analyze:
            response = self.client.post("/api/analyze", data={"expected_text": "hello"}, files={"file": ("take.webm", b"audio", "audio/webm")})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), payload)
        analyze.assert_called_once_with(paths[1], "hello", None)
        self.assertTrue(all(not os.path.exists(path) for path in paths))

    def test_webm_conversion_returns_wav_and_cleans_temp_files(self):
        paths = []

        def convert(source):
            self.assertTrue(os.path.exists(source))
            paths.append(source)
            fd, wav_path = tempfile.mkstemp(suffix=".wav")
            with os.fdopen(fd, "wb") as wav:
                wav.write(b"RIFF test wav")
            paths.append(wav_path)
            return wav_path

        with patch.object(web, "_to_wav", side_effect=convert):
            response = self.client.post(
                "/api/convert",
                files={"file": ("take.webm", b"webm audio", "audio/webm")},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "audio/wav")
        self.assertEqual(response.content, b"RIFF test wav")
        self.assertTrue(all(not os.path.exists(path) for path in paths))

    def test_webm_conversion_rejects_empty_upload(self):
        response = self.client.post(
            "/api/convert",
            files={"file": ("take.webm", b"", "audio/webm")},
        )
        self.assertEqual(response.status_code, 422)

    def test_webm_conversion_failure_cleans_upload(self):
        paths = []

        def fail(source):
            paths.append(source)
            raise ValueError("invalid WebM audio")

        with patch.object(web, "_to_wav", side_effect=fail):
            response = self.client.post(
                "/api/convert",
                files={"file": ("take.webm", b"invalid audio", "audio/webm")},
            )

        self.assertEqual(response.status_code, 500)
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
