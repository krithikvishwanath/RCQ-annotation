from __future__ import annotations

import asyncio
import json
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from rcq_llm_eval.batch import BatchConfig, evaluate_query
from rcq_llm_eval.dataset import Query
from rcq_llm_eval.schema import AnnotationSchema


ROOT = Path(__file__).resolve().parents[1]


def valid_annotation(schema: AnnotationSchema) -> dict[str, object]:
    annotation = {field.key: field.allowed[0] for field in schema.fields}
    annotation["medicine_division"] = "Not applicable"
    annotation["ctx_patient"] = 0
    annotation["ctx_institutional"] = 0
    annotation["ctx_evidence"] = 0
    annotation["needs_context"] = 0
    return annotation


def response(content: str, *, total_tokens: int = 100) -> SimpleNamespace:
    return SimpleNamespace(
        id="response-1",
        model="Barney",
        usage=SimpleNamespace(
            prompt_tokens=total_tokens - 20,
            completion_tokens=20,
            total_tokens=total_tokens,
        ),
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(content=content),
                finish_reason="stop",
            )
        ],
    )


class FakeCompletions:
    def __init__(self, responses: list[SimpleNamespace]):
        self.responses = list(responses)
        self.requests: list[dict[str, object]] = []

    async def create(self, **request: object) -> SimpleNamespace:
        self.requests.append(request)
        return self.responses.pop(0)


class BatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.schema = AnnotationSchema.load(ROOT / "annotation_schema.json")
        self.config = BatchConfig(
            model="Barney",
            max_tokens=1_200,
            temperature=0.0,
            max_retries=2,
            json_mode=False,
            include_query_text=False,
            prompt_sha256="prompt-hash",
        )

    def run_evaluation(self, responses: list[SimpleNamespace]) -> tuple[dict[str, object], FakeCompletions]:
        completions = FakeCompletions(responses)
        client = SimpleNamespace(chat=SimpleNamespace(completions=completions))

        async def run() -> dict[str, object]:
            result = await evaluate_query(
                client=client,
                query=Query("Q1", "What is the dose?"),
                system_prompt="canonical prompt",
                schema=self.schema,
                semaphore=asyncio.Semaphore(1),
                abort_event=asyncio.Event(),
                config=self.config,
            )
            assert result is not None
            return result

        return asyncio.run(run()), completions

    def test_successful_response_is_validated_and_usage_is_recorded(self) -> None:
        result, completions = self.run_evaluation(
            [response(json.dumps(valid_annotation(self.schema)))]
        )
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["attempts"], 1)
        self.assertEqual(result["usage"]["total_tokens"], 100)
        self.assertNotIn("question", result)
        self.assertEqual(completions.requests[0]["model"], "Barney")
        self.assertNotIn("response_format", completions.requests[0])

    def test_invalid_json_is_retried_with_identical_prompt_and_usage_is_summed(self) -> None:
        valid = json.dumps(valid_annotation(self.schema))
        with patch("rcq_llm_eval.batch.asyncio.sleep", new=AsyncMock()):
            result, completions = self.run_evaluation(
                [response("not json", total_tokens=90), response(valid, total_tokens=110)]
            )
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["attempts"], 2)
        self.assertEqual(result["usage"]["total_tokens"], 200)
        self.assertEqual(completions.requests[0]["messages"], completions.requests[1]["messages"])


if __name__ == "__main__":
    unittest.main()
