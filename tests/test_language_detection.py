import json
from pathlib import Path
import unittest

from language_detection import detect_language_evidence, detect_supported_language


class LanguageDetectionTests(unittest.TestCase):
    def test_shared_contract_corpus(self):
        contract_path = Path(__file__).resolve().parents[1] / "language_contract_cases.json"
        contract = json.loads(contract_path.read_text(encoding="utf-8"))
        for case in contract["cases"]:
            with self.subTest(case=case["id"]):
                self.assertEqual(case["expected"], detect_language_evidence(case["text"]))
        for case in contract["generated_cases"]:
            text = (case["prefix"] * case["repeat"]) + case["suffix"]
            with self.subTest(case=case["id"]):
                self.assertEqual(case["expected"], detect_language_evidence(text))

    def test_requires_a_unique_top_score(self):
        self.assertIsNone(detect_supported_language("photo"))
        self.assertIsNone(detect_supported_language("video"))
        self.assertIsNone(detect_supported_language("ok"))
        self.assertEqual("en", detect_supported_language("Are you available now?"))
        self.assertEqual("fr", detect_supported_language("bonjour"))

    def test_explicit_request_breaks_ambiguity_unless_requests_tie(self):
        self.assertEqual("en", detect_supported_language("English"))
        self.assertIsNone(detect_supported_language("english français"))

    def test_text_and_token_limits_bound_detection_work(self):
        self.assertIsNone(detect_supported_language("x" * 4096 + " hello"))
        self.assertIsNone(detect_supported_language(("x " * 256) + "hello"))

    def test_italian_greetings_inquiries_and_explicit_requests(self):
        self.assertEqual("it", detect_supported_language("Ciao, ragazze disponibili?"))
        self.assertEqual("it", detect_supported_language("Buongiorno, quanto costa?"))
        self.assertEqual("it", detect_supported_language("Parlami in italiano per favore"))
        self.assertEqual("en", detect_supported_language("Non parlo italiano, speak in english"))


if __name__ == "__main__":
    unittest.main()
