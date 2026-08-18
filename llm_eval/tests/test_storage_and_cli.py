from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from rcq_llm_eval.cli import anthropic_api_key, connection_settings, parse_args
from rcq_llm_eval.storage import OutputStore


class StorageAndConnectionTests(unittest.TestCase):
    def test_output_store_resumes_successes_and_rejects_mixed_runs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "results.jsonl"
            expected = {"run_fingerprint": "same-run", "created_at": "now"}
            with OutputStore(output) as store:
                store.prepare_manifest(expected)
                store.append({"status": "error", "query_id": "Q1"})
                store.append({"status": "ok", "query_id": "Q2"})
                self.assertEqual(store.successful_query_ids(), {"Q2"})

            with OutputStore(output) as store:
                self.assertEqual(store.prepare_manifest(expected)["run_fingerprint"], "same-run")
                with self.assertRaisesRegex(RuntimeError, "different dataset"):
                    store.prepare_manifest({"run_fingerprint": "different-run"})

    def test_connection_requires_tracked_gateway_and_real_identity(self) -> None:
        with patch.dict(
            os.environ,
            {
                "OPENAI_BASE_URL": "http://compute123:8001/v1",
                "OPENAI_API_KEY": "kv1234",
            },
            clear=True,
        ):
            self.assertEqual(
                connection_settings(),
                ("http://compute123:8001/v1", "kv1234"),
            )

        with patch.dict(
            os.environ,
            {"OPENAI_BASE_URL": "http://compute123:8000/v1", "OPENAI_API_KEY": "kv1234"},
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "port 8001"):
                connection_settings()

        with patch.dict(
            os.environ,
            {"OPENAI_BASE_URL": "http://compute123:8001/v1", "OPENAI_API_KEY": "dummy"},
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "NYU NetID"):
                connection_settings()

    def test_anthropic_key_is_required_without_logging_or_transforming_it(self) -> None:
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "secret-value"}, clear=True):
            self.assertEqual(anthropic_api_key(), "secret-value")
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "ANTHROPIC_API_KEY is missing"):
                anthropic_api_key()

    def test_provider_defaults_keep_outputs_and_models_separate(self) -> None:
        barney = parse_args([])
        claude = parse_args(["--provider", "anthropic"])
        self.assertEqual(barney.model, "Barney")
        self.assertEqual(barney.output.name, "barney_predictions.jsonl")
        self.assertEqual(barney.temperature, 0.0)
        self.assertEqual(claude.model, "claude-sonnet-5")
        self.assertEqual(claude.output.name, "claude_predictions.jsonl")
        self.assertIsNone(claude.temperature)


if __name__ == "__main__":
    unittest.main()
