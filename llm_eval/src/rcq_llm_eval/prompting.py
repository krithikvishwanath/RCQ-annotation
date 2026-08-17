from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass
from pathlib import Path

from .dataset import Query


@dataclass(frozen=True)
class ConcurrencyPlan:
    estimated_input_tokens: int
    max_output_tokens: int
    estimated_tokens_per_request: int
    token_budget: int
    max_concurrency: int
    concurrency: int
    estimated_tokens_in_flight: int


def load_system_prompt(path: Path, schema_version: str) -> tuple[str, str]:
    prompt_bytes = path.read_bytes()
    prompt = prompt_bytes.decode("utf-8-sig")
    if f"Clinician Query Annotation Codebook ({schema_version})" not in prompt:
        raise ValueError(
            f"Prompt does not identify the schema version {schema_version}: {path}"
        )
    if "exactly the 24 fields" not in prompt or "Return a single JSON object" not in prompt:
        raise ValueError("Prompt is missing the required 24-field JSON output contract.")
    return prompt, hashlib.sha256(prompt_bytes).hexdigest()


def build_messages(system_prompt: str, query: Query) -> list[dict[str, str]]:
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"Question:  {query.text}"},
    ]


def plan_concurrency(
    system_prompt: str,
    queries: list[Query],
    *,
    max_output_tokens: int,
    token_budget: int,
    max_concurrency: int,
) -> ConcurrencyPlan:
    if max_output_tokens < 1:
        raise ValueError("max_output_tokens must be positive.")
    if token_budget < 1:
        raise ValueError("token_budget must be positive.")
    if max_concurrency < 1:
        raise ValueError("max_concurrency must be positive.")

    largest_query = max((len(query.text) for query in queries), default=0)
    # Barney's guidance recommends ~4 characters/token. Add a small chat-envelope
    # allowance and use the largest pending query so the plan is conservative.
    estimated_input_tokens = math.ceil((len(system_prompt) + largest_query) / 4) + 32
    per_request = estimated_input_tokens + max_output_tokens
    budget_concurrency = max(1, (token_budget - 1) // per_request)
    concurrency = max(
        1,
        min(max_concurrency, budget_concurrency, max(1, len(queries))),
    )
    return ConcurrencyPlan(
        estimated_input_tokens=estimated_input_tokens,
        max_output_tokens=max_output_tokens,
        estimated_tokens_per_request=per_request,
        token_budget=token_budget,
        max_concurrency=max_concurrency,
        concurrency=concurrency,
        estimated_tokens_in_flight=concurrency * per_request,
    )
