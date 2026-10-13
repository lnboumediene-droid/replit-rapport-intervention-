"""Focused response regressions; no database, stored files or live API calls."""
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from pdf_import_processing import IMPORT_SCHEMA, draft_with_claude, parse_claude_response


def response(text="", reason="end_turn"):
    return SimpleNamespace(stop_reason=reason, content=[SimpleNamespace(type="text", text=text)])


def valid_data():
    return {
        "client": None, "address": None, "object": "Reprise de dalle béton",
        "tenant": None, "context": "Fouille ouverte.", "dates": ["2026-10-07"],
        "findings": ["Dalle endommagée."], "workDone": ["Reprise sur 5 m²."],
        "conclusion": ["Zone nettoyée."], "a_completer": [], "photos": [],
        "interventionState": "realisee",
    }


class ClaudeImportResponseTests(unittest.TestCase):
    def test_bare_and_fenced_json(self):
        data = valid_data()
        raw = json.dumps(data)
        for text in [raw, f"```json\n{raw}\n```", f"```\n{raw}\n```", "\ufeff" + raw]:
            with self.subTest(text=text[:15]):
                self.assertEqual(parse_claude_response(response(text)), data)

    def test_empty_and_thinking_only(self):
        for content in [[], [SimpleNamespace(type="thinking", thinking="not report data")],
                        [SimpleNamespace(type="text", text=" \n")]]:
            with self.subTest(content=content):
                with self.assertRaisesRegex(ValueError, "aucun contenu exploitable"):
                    parse_claude_response(SimpleNamespace(stop_reason="end_turn", content=content))

    def test_malformed_or_explanatory_text_rejected(self):
        for text in ["Voici le résultat : " + json.dumps(valid_data()), '{"object":']:
            with self.assertRaisesRegex(ValueError, "JSON valide"):
                parse_claude_response(response(text))

    def test_array_is_not_a_report(self):
        with self.assertRaisesRegex(ValueError, "fiche JSON valide"):
            parse_claude_response(response("[]"))

    def test_refusal_and_truncation(self):
        for reason, message in [("refusal", "refusé"), ("max_tokens", "incomplète")]:
            with self.subTest(reason=reason):
                with self.assertRaisesRegex(ValueError, message):
                    parse_claude_response(response("{}", reason))

    def test_request_enforces_schema_with_key_only_client(self):
        with patch("pdf_import_processing.Anthropic") as sdk:
            sdk.return_value.messages.create.return_value = response(json.dumps(valid_data()))
            data = draft_with_claude(
                {"text": "Date 07/10/2026. Reprise sur 5 m². Fouille ouverte. Zone nettoyée.", "photos": []},
                ["SRP"],
            )
            self.assertEqual(data, valid_data())
            self.assertEqual(set(sdk.call_args.kwargs), {"api_key"})
            config = sdk.return_value.messages.create.call_args.kwargs["output_config"]
            self.assertEqual(config["format"], {"type": "json_schema", "schema": IMPORT_SCHEMA})

    def test_fenced_json_does_not_bypass_safety_checks(self):
        for key, value, message in [
            ("workDone", ["Reprise sur 99 m²."], "Chiffres absents"),
            ("context", "SRP", "Réponse Claude refusée"),
            ("findings", "not a list", "Champ Claude invalide"),
        ]:
            data = valid_data()
            data[key] = value
            with self.subTest(key=key), patch("pdf_import_processing.Anthropic") as sdk:
                sdk.return_value.messages.create.return_value = response(f"```json\n{json.dumps(data)}\n```")
                with self.assertRaisesRegex(ValueError, message):
                    draft_with_claude({"text": "Date 07/10/2026. Reprise sur 5 m².", "photos": []}, ["SRP"])


if __name__ == "__main__":
    unittest.main()
