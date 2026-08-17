from __future__ import annotations

import asyncio
import random
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

from .dataset import Query
from .prompting import build_messages
from .schema import AnnotationSchema, AnnotationValidationError, parse_json_response


@dataclass
class TokenUsage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0

    def add(self, other: "TokenUsage") -> None:
        self.prompt_tokens += other.prompt_tokens
        self.completion_tokens += other.completion_tokens
        self.total_tokens += other.total_tokens

    def as_dict(self) -> dict[str, int]:
        return {
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "total_tokens": self.total_tokens,
        }


@dataclass(frozen=True)
class BatchConfig:
    model: str
    max_tokens: int
    temperature: float
    max_retries: int
    json_mode: bool
    include_query_text: bool
    prompt_sha256: str


def _response_usage(response: Any) -> TokenUsage:
    usage = getattr(response, "usage", None)
    prompt_tokens = int(getattr(usage, "prompt_tokens", 0) or 0)
    completion_tokens = int(getattr(usage, "completion_tokens", 0) or 0)
    total_tokens = int(getattr(usage, "total_tokens", 0) or 0)
    if not total_tokens:
        total_tokens = prompt_tokens + completion_tokens
    return TokenUsage(prompt_tokens, completion_tokens, total_tokens)


def _status_code(error: Exception) -> int | None:
    value = getattr(error, "status_code", None)
    return value if isinstance(value, int) else None


def _retryable_api_error(error: Exception) -> bool:
    status = _status_code(error)
    if status in {408, 409, 429} or (status is not None and status >= 500):
        return True
    return type(error).__name__ in {
        "APIConnectionError",
        "APITimeoutError",
        "RateLimitError",
        "InternalServerError",
    }


def _fatal_api_error(error: Exception) -> bool:
    status = _status_code(error)
    return status in {400, 401, 403, 404, 405, 422}


def _safe_error(error: Exception) -> str:
    return " ".join(str(error).split())[:600] or type(error).__name__


async def evaluate_query(
    *,
    client: Any,
    query: Query,
    system_prompt: str,
    schema: AnnotationSchema,
    semaphore: asyncio.Semaphore,
    abort_event: asyncio.Event,
    config: BatchConfig,
) -> dict[str, Any] | None:
    started = time.perf_counter()
    total_usage = TokenUsage()
    last_error: Exception | None = None
    error_kind = "unknown"
    max_attempts = config.max_retries + 1

    for attempt in range(1, max_attempts + 1):
        if abort_event.is_set():
            return None
        try:
            request: dict[str, Any] = {
                "model": config.model,
                "messages": build_messages(system_prompt, query),
                "temperature": config.temperature,
                "max_tokens": config.max_tokens,
            }
            if config.json_mode:
                request["response_format"] = {"type": "json_object"}

            async with semaphore:
                if abort_event.is_set():
                    return None
                response = await client.chat.completions.create(**request)

            total_usage.add(_response_usage(response))
            if not getattr(response, "choices", None):
                raise ValueError("The model response did not contain a completion choice.")
            choice = response.choices[0]
            content = getattr(getattr(choice, "message", None), "content", None)
            if not isinstance(content, str):
                raise ValueError("The model response did not contain text content.")
            parsed, parse_mode = parse_json_response(content)
            annotation = schema.validate(parsed)

            record: dict[str, Any] = {
                "format_version": 1,
                "status": "ok",
                "query_id": query.query_id,
                "query_sha256": query.sha256,
                "annotation": annotation,
                "model": config.model,
                "response_model": str(getattr(response, "model", "") or ""),
                "response_id": str(getattr(response, "id", "") or ""),
                "finish_reason": str(getattr(choice, "finish_reason", "") or ""),
                "prompt_sha256": config.prompt_sha256,
                "parse_mode": parse_mode,
                "attempts": attempt,
                "usage": total_usage.as_dict(),
                "latency_seconds": round(time.perf_counter() - started, 3),
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
            if config.include_query_text:
                record["question"] = query.text
            return record
        except (AnnotationValidationError, ValueError) as error:
            last_error = error
            error_kind = "invalid_model_output"
            retryable = True
        except Exception as error:  # SDK exceptions vary across compatible servers.
            last_error = error
            error_kind = "api_error"
            retryable = _retryable_api_error(error)
            if _fatal_api_error(error):
                abort_event.set()

        if not retryable or attempt >= max_attempts:
            break
        delay = min(16.0, 2 ** (attempt - 1)) + random.uniform(0.0, 0.4)
        await asyncio.sleep(delay)

    return {
        "format_version": 1,
        "status": "error",
        "query_id": query.query_id,
        "query_sha256": query.sha256,
        "model": config.model,
        "prompt_sha256": config.prompt_sha256,
        "error_type": error_kind,
        "error": _safe_error(last_error or RuntimeError("Unknown evaluation failure.")),
        "attempts": attempt,
        "usage": total_usage.as_dict(),
        "latency_seconds": round(time.perf_counter() - started, 3),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


async def run_batch(
    *,
    client: Any,
    queries: list[Query],
    system_prompt: str,
    schema: AnnotationSchema,
    concurrency: int,
    config: BatchConfig,
    on_result: Callable[[dict[str, Any], int, int], None],
) -> tuple[list[dict[str, Any]], int]:
    semaphore = asyncio.Semaphore(concurrency)
    abort_event = asyncio.Event()
    tasks = [
        asyncio.create_task(
            evaluate_query(
                client=client,
                query=query,
                system_prompt=system_prompt,
                schema=schema,
                semaphore=semaphore,
                abort_event=abort_event,
                config=config,
            )
        )
        for query in queries
    ]

    results: list[dict[str, Any]] = []
    try:
        for completed, task in enumerate(asyncio.as_completed(tasks), start=1):
            result = await task
            if result is not None:
                results.append(result)
                on_result(result, completed, len(tasks))
        return results, len(tasks) - len(results)
    finally:
        unfinished = [task for task in tasks if not task.done()]
        for task in unfinished:
            task.cancel()
        if unfinished:
            await asyncio.gather(*unfinished, return_exceptions=True)
