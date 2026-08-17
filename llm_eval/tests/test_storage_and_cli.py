from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from rcq_llm_eval.cli import connection_settings
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


if __name__ == "__main__":
    unittest.main()
