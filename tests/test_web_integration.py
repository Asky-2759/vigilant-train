"""API contract tests without model downloads. Run: python -m unittest discover -s tests"""
import os
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import ai_advice
from fastapi.testclient import TestClient
from backend import app as web
from backend import settings as settings_module


class AIAdviceTests(unittest.TestCase):
    def test_generate_feedback_calls_configured_gemini_model(self):
        with patch("google.genai.Client") as client_class:
            client = client_class.return_value
            client.__enter__.return_value = client
            client.models.generate_content.return_value.text = "  Focus on the first vowel.  "
            feedback = ai_advice.generate_pronunciation_feedback(
                [("hello", "hɛlo", "həlo")],
                api_key="test-key",
                model="test-model",
            )

        self.assertEqual(feedback, "Focus on the first vowel.")
        client_class.assert_called_once_with(api_key="test-key")
        client.__enter__.assert_called_once_with()
        client.__exit__.assert_called_once()
        request = client.models.generate_content.call_args.kwargs
        self.assertEqual(request["model"], "test-model")
        self.assertIn('"phoneme_transcription": "hɛlo"', request["contents"])
        self.assertIn('"target_ipa": "həlo"', request["contents"])


class SettingsTests(unittest.TestCase):
    def test_load_defaults_to_supported_gemini_text_model(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(settings_module, "ROOT", Path(directory)), patch.dict(
                os.environ, {}, clear=True
            ):
                settings = settings_module.load()

        self.assertEqual(settings.gemini_model_id, "gemini-3.8-flash")

    def test_load_reads_exported_google_key_from_dotenv(self):
        with tempfile.TemporaryDirectory() as directory:
            env_path = Path(directory) / ".env"
            env_path.write_text(
                "export GOOGLE_API_KEY='test-key' # comment\n"
                "GEMINI_MODEL_ID=gemini-test\n",
                encoding="utf-8",
            )
            with patch.object(settings_module, "ROOT", Path(directory)), patch.dict(os.environ, {}, clear=True):
                settings = settings_module.load()

        self.assertEqual(settings.gemini_api_key, "test-key")
        self.assertEqual(settings.gemini_model_id, "gemini-test")

    def test_gemini_key_and_process_environment_take_precedence(self):
        with tempfile.TemporaryDirectory() as directory:
            env_path = Path(directory) / ".env"
            env_path.write_text(
                "GEMINI_API_KEY=dotenv-gemini\nGOOGLE_API_KEY=dotenv-google\n",
                encoding="utf-8",
            )
            with patch.object(settings_module, "ROOT", Path(directory)), patch.dict(
                os.environ,
                {"GEMINI_API_KEY": "process-gemini", "GOOGLE_API_KEY": "process-google"},
                clear=True,
            ):
                settings = settings_module.load()

        self.assertEqual(settings.gemini_api_key, "process-gemini")


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
        settings = replace(web.SETTINGS, gemini_api_key="")
        with patch.object(web, "SETTINGS", settings), patch.object(web, "_to_wav", side_effect=convert), patch.object(web.scoring, "analyze", return_value=payload):
            response = self.client.post("/api/analyze", data={"expected_text": "hello"}, files={"file": ("take.webm", b"audio", "audio/webm")})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            **payload,
            "ai_feedback": None,
            "ai_feedback_error": (
                "AI feedback is not configured. Set GEMINI_API_KEY or GOOGLE_API_KEY "
                "in the root .env file or server environment, then restart the server."
            ),
        })
        self.assertTrue(all(not os.path.exists(path) for path in paths))

    def test_analysis_includes_ai_feedback_from_word_phonemes(self):
        paths = []
        def convert(source):
            paths.append(source)
            fd, path = tempfile.mkstemp(suffix=".wav")
            os.close(fd)
            paths.append(path)
            return path

        payload = {
            "score": 80,
            "words": [{"word": "hello", "heard": "hɛlo", "expected": "həlo"}],
        }
        settings = replace(web.SETTINGS, gemini_api_key="test-key")
        with (
            patch.object(web, "SETTINGS", settings),
            patch.object(web, "_to_wav", side_effect=convert),
            patch.object(web.scoring, "analyze", return_value=payload),
            patch.object(web.ai_advice, "generate_pronunciation_feedback", return_value="Work on the first vowel.") as generate,
        ):
            response = self.client.post(
                "/api/analyze",
                data={"expected_text": "hello"},
                files={"file": ("take.webm", b"audio", "audio/webm")},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["ai_feedback"], "Work on the first vowel.")
        generate.assert_called_once_with(
            [("hello", "hɛlo", "həlo")],
            api_key="test-key",
            model=settings.gemini_model_id,
        )
        self.assertTrue(all(not os.path.exists(path) for path in paths))

    def test_ai_feedback_failure_keeps_analysis_and_explains_unavailability(self):
        payload = {
            "score": 80,
            "words": [{"word": "hello", "heard": "hɛlo", "expected": "həlo"}],
        }
        settings = replace(web.SETTINGS, gemini_api_key="test-key")
        with (
            patch.object(web, "SETTINGS", settings),
            patch.object(web, "_to_wav", return_value="analysis.wav"),
            patch.object(web.scoring, "analyze", return_value=payload),
            patch.object(web.ai_advice, "generate_pronunciation_feedback", side_effect=RuntimeError("provider unavailable")),
            self.assertLogs("pronounce", level="ERROR") as captured_logs,
        ):
            response = self.client.post(
                "/api/analyze",
                data={"expected_text": "hello"},
                files={"file": ("take.webm", b"audio", "audio/webm")},
            )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["score"], 80)
        self.assertIsNone(response.json()["ai_feedback"])
        self.assertIn("could not be generated", response.json()["ai_feedback_error"])
        self.assertIn("AI feedback generation failed", captured_logs.output[0])
        self.assertIn("provider unavailable", captured_logs.output[0])

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
