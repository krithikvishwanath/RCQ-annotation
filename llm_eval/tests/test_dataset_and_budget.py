from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from rcq_llm_eval.dataset import Query, load_queries
from rcq_llm_eval.prompting import build_messages, plan_concurrency


class DatasetAndBudgetTests(unittest.TestCase):
    def test_csv_loader_handles_multiline_text_and_known_encoding_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "queries.csv"
            path.write_text(
                '\ufeffrow_index,text\r\n1,"line one\nline two"\r\n2,patient‚Äôs dose\r\n',
                encoding="utf-8",
            )
            queries = load_queries(path)
        self.assertEqual(queries[0], Query("1", "line one\nline two"))
        self.assertEqual(queries[1], Query("2", "patient's dose"))

    def test_csv_loader_rejects_duplicate_ids(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "queries.csv"
            path.write_text("row_index,text\n7,First\n7,Second\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Duplicate query ID"):
                load_queries(path)

    def test_single_prompt_message_contract(self) -> None:
        messages = build_messages("canonical codebook", Query("7", "What is the dose?"))
        self.assertEqual(messages[0], {"role": "system", "content": "canonical codebook"})
        self.assertEqual(messages[1]["content"], "Question:  What is the dose?")

    def test_default_budget_limits_a_ten_thousand_token_request_to_five_workers(self) -> None:
        plan = plan_concurrency(
            "x" * 34_452,
            [Query("1", "short query")],
            max_output_tokens=1_200,
            token_budget=50_000,
            max_concurrency=16,
        )
        self.assertEqual(plan.concurrency, 1)  # Only one query is pending.

        many_queries = [Query(str(index), "short query") for index in range(100)]
        plan = plan_concurrency(
            "x" * 34_452,
            many_queries,
            max_output_tokens=1_200,
            token_budget=50_000,
            max_concurrency=16,
        )
        self.assertEqual(plan.concurrency, 5)
        self.assertLess(plan.estimated_tokens_in_flight, 50_000)

    def test_provider_schema_overhead_reduces_concurrency(self) -> None:
        queries = [Query(str(index), "short query") for index in range(100)]
        plan = plan_concurrency(
            "x" * 34_822,
            queries,
            max_output_tokens=1_200,
            token_budget=50_000,
            max_concurrency=16,
            supplemental_input_chars=4_000,
            characters_per_token=2.65,
        )
        self.assertEqual(plan.concurrency, 3)
        self.assertLess(plan.estimated_tokens_in_flight, 50_000)


if __name__ == "__main__":
    unittest.main()
