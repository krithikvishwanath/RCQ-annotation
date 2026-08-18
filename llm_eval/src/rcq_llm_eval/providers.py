from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from .dataset import Query
from .prompting import build_messages
from .schema import AnnotationSchema


@dataclass(frozen=True)
class ProviderCompletion:
    text: str
    response_id: str
    response_model: str
    finish_reason: str
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int
    uncached_input_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0


class CompletionProvider(Protocol):
    async def complete(
        self,
        *,
        model: str,
        system_prompt: str,
        query: Query,
        schema: AnnotationSchema,
        max_tokens: int,
        temperature: float | None,
    ) -> ProviderCompletion: ...


def _int_attr(value: object, name: str) -> int:
    return int(getattr(value, name, 0) or 0)


class OpenAICompatibleProvider:
    """Adapter for Barney's OpenAI-compatible chat-completions endpoint."""

    def __init__(self, client: Any, *, json_mode: bool = False):
        self.client = client
        self.json_mode = json_mode

    async def complete(
        self,
        *,
        model: str,
        system_prompt: str,
        query: Query,
        schema: AnnotationSchema,
        max_tokens: int,
        temperature: float | None,
    ) -> ProviderCompletion:
        del schema  # Barney compatibility mode relies on the canonical prompt + local validation.
        request: dict[str, Any] = {
            "model": model,
            "messages": build_messages(system_prompt, query),
            "max_tokens": max_tokens,
        }
        if temperature is not None:
            request["temperature"] = temperature
        if self.json_mode:
            request["response_format"] = {"type": "json_object"}

        response = await self.client.chat.completions.create(**request)
        if not getattr(response, "choices", None):
            raise ValueError("The model response did not contain a completion choice.")
        choice = response.choices[0]
        content = getattr(getattr(choice, "message", None), "content", None)
        if not isinstance(content, str):
            raise ValueError("The model response did not contain text content.")
        usage = getattr(response, "usage", None)
        prompt_tokens = _int_attr(usage, "prompt_tokens")
        completion_tokens = _int_attr(usage, "completion_tokens")
        total_tokens = _int_attr(usage, "total_tokens") or prompt_tokens + completion_tokens
        return ProviderCompletion(
            text=content,
            response_id=str(getattr(response, "id", "") or ""),
            response_model=str(getattr(response, "model", "") or ""),
            finish_reason=str(getattr(choice, "finish_reason", "") or ""),
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total_tokens,
            uncached_input_tokens=prompt_tokens,
        )


class AnthropicProvider:
    """Adapter for Claude's Messages API with native JSON Schema output."""

    def __init__(self, client: Any):
        self.client = client

    async def complete(
        self,
        *,
        model: str,
        system_prompt: str,
        query: Query,
        schema: AnnotationSchema,
        max_tokens: int,
        temperature: float | None,
    ) -> ProviderCompletion:
        request: dict[str, Any] = {
            "model": model,
            "system": [
                {
                    "type": "text",
                    "text": system_prompt,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            "messages": [{"role": "user", "content": f"Question:  {query.text}"}],
            "max_tokens": max_tokens,
            # This is a bounded classification task. Sonnet 5 otherwise enables
            # adaptive thinking and can spend the entire output cap before JSON.
            "thinking": {"type": "disabled"},
            "output_config": {
                "format": {
                    "type": "json_schema",
                    "schema": schema.to_json_schema(),
                }
            },
        }
        if temperature is not None:
            request["temperature"] = temperature

        response = await self.client.messages.create(**request)
        text_blocks = [
            block.text
            for block in getattr(response, "content", [])
            if getattr(block, "type", None) == "text" and isinstance(getattr(block, "text", None), str)
        ]

        usage = getattr(response, "usage", None)
        uncached_input_tokens = _int_attr(usage, "input_tokens")
        cache_creation_input_tokens = _int_attr(usage, "cache_creation_input_tokens")
        cache_read_input_tokens = _int_attr(usage, "cache_read_input_tokens")
        prompt_tokens = (
            uncached_input_tokens + cache_creation_input_tokens + cache_read_input_tokens
        )
        completion_tokens = _int_attr(usage, "output_tokens")
        return ProviderCompletion(
            # Return an empty string rather than raising here so the batch layer
            # can retain usage and stop metadata before classifying the failure.
            text="".join(text_blocks),
            response_id=str(getattr(response, "id", "") or ""),
            response_model=str(getattr(response, "model", "") or ""),
            finish_reason=str(getattr(response, "stop_reason", "") or ""),
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=prompt_tokens + completion_tokens,
            uncached_input_tokens=uncached_input_tokens,
            cache_creation_input_tokens=cache_creation_input_tokens,
            cache_read_input_tokens=cache_read_input_tokens,
        )
