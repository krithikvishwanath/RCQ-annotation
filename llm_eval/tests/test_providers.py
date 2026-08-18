from __future__ import annotations

import asyncio
import unittest
from pathlib import Path
from types import SimpleNamespace

from rcq_llm_eval.dataset import Query
from rcq_llm_eval.providers import AnthropicProvider, OpenAICompatibleProvider
from rcq_llm_eval.schema import AnnotationSchema


ROOT = Path(__file__).resolve().parents[1]


class CapturingCreate:
    def __init__(self, response: object):
        self.response = response
        self.requests: list[dict[str, object]] = []

    async def create(self, **request: object) -> object:
        self.requests.append(request)
        return self.response


class ProviderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.schema = AnnotationSchema.load(ROOT / "annotation_schema.json")
        self.query = Query("Q1", "What is the dose?")

    def test_anthropic_uses_native_json_schema_and_maps_usage(self) -> None:
        create = CapturingCreate(
            SimpleNamespace(
                id="msg_1",
                model="claude-sonnet-5",
                stop_reason="end_turn",
                content=[SimpleNamespace(type="text", text='{"ok":true}')],
                usage=SimpleNamespace(
                    input_tokens=10,
                    cache_creation_input_tokens=70,
                    cache_read_input_tokens=0,
                    output_tokens=20,
                ),
            )
        )
        provider = AnthropicProvider(SimpleNamespace(messages=create))
        completion = asyncio.run(
            provider.complete(
                model="claude-sonnet-5",
                system_prompt="canonical prompt",
                query=self.query,
                schema=self.schema,
                max_tokens=1_200,
                temperature=None,
            )
        )
        request = create.requests[0]
        self.assertEqual(
            request["system"],
            [
                {
                    "type": "text",
                    "text": "canonical prompt",
                    "cache_control": {"type": "ephemeral"},
                }
            ],
        )
        self.assertEqual(request["messages"], [{"role": "user", "content": "Question:  What is the dose?"}])
        self.assertNotIn("temperature", request)
        self.assertEqual(request["thinking"], {"type": "disabled"})
        output_format = request["output_config"]["format"]
        self.assertEqual(output_format["type"], "json_schema")
        self.assertEqual(output_format["schema"]["required"], list(self.schema.keys))
        self.assertEqual(completion.total_tokens, 100)
        self.assertEqual(completion.uncached_input_tokens, 10)
        self.assertEqual(completion.cache_creation_input_tokens, 70)
        self.assertEqual(completion.cache_read_input_tokens, 0)
        self.assertEqual(completion.finish_reason, "end_turn")

    def test_barney_adapter_preserves_openai_compatible_request(self) -> None:
        create = CapturingCreate(
            SimpleNamespace(
                id="chatcmpl_1",
                model="Barney",
                choices=[
                    SimpleNamespace(
                        message=SimpleNamespace(content='{"ok":true}'),
                        finish_reason="stop",
                    )
                ],
                usage=SimpleNamespace(prompt_tokens=80, completion_tokens=20, total_tokens=100),
            )
        )
        client = SimpleNamespace(chat=SimpleNamespace(completions=create))
        provider = OpenAICompatibleProvider(client, json_mode=True)
        completion = asyncio.run(
            provider.complete(
                model="Barney",
                system_prompt="canonical prompt",
                query=self.query,
                schema=self.schema,
                max_tokens=1_200,
                temperature=0.0,
            )
        )
        request = create.requests[0]
        self.assertEqual(request["messages"][0]["content"], "canonical prompt")
        self.assertEqual(request["response_format"], {"type": "json_object"})
        self.assertEqual(completion.total_tokens, 100)


if __name__ == "__main__":
    unittest.main()
