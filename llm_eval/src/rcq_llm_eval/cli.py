from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from .batch import BatchConfig, TokenUsage, run_batch
from .dataset import Query, file_sha256, load_queries
from .prompting import ConcurrencyPlan, load_system_prompt, plan_concurrency
from .providers import AnthropicProvider, CompletionProvider, OpenAICompatibleProvider
from .schema import AnnotationSchema
from .storage import OutputStore


def discover_repo_root() -> Path:
    configured = os.environ.get("RCQ_REPO_ROOT", "").strip()
    candidates = [Path(configured).expanduser()] if configured else []
    candidates.extend([Path.cwd(), Path.cwd().parent])
    candidates.extend(Path(__file__).resolve().parents)
    for candidate in candidates:
        resolved = candidate.resolve()
        if (resolved / "prompt.txt").is_file() and (
            resolved / "llm_eval" / "annotation_schema.json"
        ).is_file():
            return resolved
    raise RuntimeError(
        "Could not locate the RCQ repository. Run from the repo/llm_eval directory "
        "or set RCQ_REPO_ROOT."
    )


REPO_ROOT = discover_repo_root()
LLM_EVAL_ROOT = REPO_ROOT / "llm_eval"
DEFAULT_INPUT = REPO_ROOT / "real_chat_sample.csv"
DEFAULT_PROMPT = LLM_EVAL_ROOT / "prompt_compact.txt"
DEFAULT_SCHEMA = LLM_EVAL_ROOT / "annotation_schema.json"
DEFAULT_MODELS = {
    "barney": "Barney",
    "anthropic": "claude-sonnet-5",
}
DEFAULT_OUTPUTS = {
    "barney": LLM_EVAL_ROOT / "outputs" / "barney_predictions.jsonl",
    "anthropic": LLM_EVAL_ROOT / "outputs" / "claude_predictions.jsonl",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Annotate RCQ queries through Barney or Claude with bounded asynchronous concurrency."
    )
    parser.add_argument(
        "--provider",
        choices=tuple(DEFAULT_MODELS),
        default="barney",
        help="API provider (default: barney).",
    )
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--prompt", type=Path, default=DEFAULT_PROMPT)
    parser.add_argument("--schema", type=Path, default=DEFAULT_SCHEMA)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--model")
    parser.add_argument("--token-budget", type=int, default=50_000)
    parser.add_argument(
        "--max-concurrency",
        type=int,
        default=16,
        help="Hard worker ceiling; the token planner usually lowers this automatically.",
    )
    parser.add_argument("--max-tokens", type=int, default=1_200)
    parser.add_argument("--max-retries", type=int, default=4)
    parser.add_argument("--request-timeout", type=float, default=240.0)
    parser.add_argument(
        "--temperature",
        type=float,
        help="Sampling temperature. Defaults to 0 for Barney and the provider default for Claude.",
    )
    parser.add_argument("--limit", type=int)
    parser.add_argument(
        "--query-id",
        action="append",
        default=[],
        help="Evaluate only this stable query ID; repeat to select multiple IDs.",
    )
    parser.add_argument(
        "--json-mode",
        action="store_true",
        help="Request OpenAI-compatible JSON mode from Barney (Claude always uses JSON Schema).",
    )
    parser.add_argument(
        "--include-query-text",
        action="store_true",
        help="Duplicate query text into output JSONL (off by default for data minimization).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate files and print the token/concurrency plan without contacting an API.",
    )
    args = parser.parse_args(argv)
    if args.model is None:
        args.model = DEFAULT_MODELS[args.provider]
    if args.output is None:
        args.output = DEFAULT_OUTPUTS[args.provider]
    if args.provider == "barney" and args.temperature is None:
        args.temperature = 0.0
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive.")
    if args.max_retries < 0:
        parser.error("--max-retries cannot be negative.")
    if args.request_timeout <= 0:
        parser.error("--request-timeout must be positive.")
    if args.temperature is not None and not 0 <= args.temperature <= 2:
        parser.error("--temperature must be between 0 and 2.")
    if not str(args.model).strip():
        parser.error("--model cannot be empty.")
    if args.provider == "anthropic" and args.json_mode:
        parser.error("--json-mode is only for Barney; Claude uses native JSON Schema automatically.")
    if args.model == "claude-sonnet-5" and args.temperature is not None:
        parser.error("claude-sonnet-5 does not accept a temperature override; omit --temperature.")
    return args


def load_environment() -> None:
    try:
        from dotenv import load_dotenv
    except ImportError:
        return
    load_dotenv(REPO_ROOT / ".env", override=False)
    load_dotenv(LLM_EVAL_ROOT / ".env", override=False)


def select_queries(queries: list[Query], query_ids: list[str], limit: int | None) -> list[Query]:
    selected = queries
    if query_ids:
        requested = set(query_ids)
        known = {query.query_id for query in queries}
        missing = sorted(requested - known)
        if missing:
            raise ValueError(f"Unknown --query-id value(s): {', '.join(missing)}")
        selected = [query for query in queries if query.query_id in requested]
    if limit is not None:
        selected = selected[:limit]
    return selected


def connection_settings() -> tuple[str, str]:
    base_url = os.environ.get("OPENAI_BASE_URL", "").strip()
    api_key = os.environ.get("OPENAI_API_KEY", "").strip()
    if not base_url:
        raise RuntimeError("OPENAI_BASE_URL is missing. Set the current Barney port-8001 /v1 URL.")
    if not api_key or api_key.lower() in {"dummy", "your_netid", "your_nyu_netid", "-"}:
        raise RuntimeError("OPENAI_API_KEY must be your NYU NetID so Barney usage is attributed correctly.")

    try:
        parsed = urlparse(base_url)
        port = parsed.port
    except ValueError as error:
        raise RuntimeError("OPENAI_BASE_URL is not a valid URL.") from error
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise RuntimeError("OPENAI_BASE_URL must be an HTTP(S) URL.")
    if port != 8001:
        raise RuntimeError("OPENAI_BASE_URL must use Barney's tracked gateway on port 8001.")
    if parsed.path.rstrip("/") != "/v1":
        raise RuntimeError("OPENAI_BASE_URL must end in /v1.")
    if "<" in base_url or ">" in base_url:
        raise RuntimeError("Replace the placeholder in OPENAI_BASE_URL with the current head node.")
    return base_url, api_key


def anthropic_api_key() -> str:
    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is missing. Add it to the repository or llm_eval .env file.")
    return api_key


def build_run_metadata(
    *,
    args: argparse.Namespace,
    selected: list[Query],
    dataset_sha256: str,
    prompt_sha256: str,
    schema_sha256: str,
    schema_version: str,
) -> dict[str, object]:
    fingerprint_input = {
        "format_version": 1,
        "provider": args.provider,
        "dataset_sha256": dataset_sha256,
        "selected_query_ids": [query.query_id for query in selected],
        "prompt_sha256": prompt_sha256,
        "schema_sha256": schema_sha256,
        "model": args.model,
        "max_tokens": args.max_tokens,
        "temperature": args.temperature,
        "response_format": (
            "anthropic_json_schema"
            if args.provider == "anthropic"
            else "openai_json_object" if args.json_mode else "prompt_only"
        ),
        "thinking": "disabled" if args.provider == "anthropic" else None,
        "prompt_cache": "ephemeral_5m" if args.provider == "anthropic" else None,
        "include_query_text": args.include_query_text,
    }
    fingerprint = hashlib.sha256(
        json.dumps(fingerprint_input, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return {
        **fingerprint_input,
        "run_fingerprint": fingerprint,
        "schema_version": schema_version,
        "created_at": utc_now(),
        "updated_at": utc_now(),
        "input_records": len(selected),
    }


def print_plan(
    *,
    args: argparse.Namespace,
    total_selected: int,
    already_complete: int,
    pending: int,
    plan: ConcurrencyPlan,
) -> None:
    print(f"Provider/model:           {args.provider} / {args.model}")
    print(f"Selected queries:          {total_selected}")
    print(f"Already complete:          {already_complete}")
    print(f"Pending requests:          {pending}")
    print(f"Estimated input/request:   {plan.estimated_input_tokens:,} tokens")
    print(f"Maximum output/request:    {plan.max_output_tokens:,} tokens")
    print(f"Estimated total/request:   {plan.estimated_tokens_per_request:,} tokens")
    print(f"Token budget:              {plan.token_budget:,} tokens in flight")
    print(f"Planned concurrency:       {plan.concurrency}")
    print(f"Estimated tokens in flight:{plan.estimated_tokens_in_flight:>10,}")
    if plan.estimated_tokens_per_request >= plan.token_budget:
        print("WARNING: one request alone is estimated to meet or exceed the token budget.")
    if args.provider == "anthropic":
        print("JSON response mode:         native JSON Schema")
        print("Extended thinking:          disabled for bounded classification")
        print("Prompt cache:               5-minute ephemeral system-prompt cache")
    elif args.json_mode:
        print("JSON response mode:         requested (server support required)")
    else:
        print("JSON response mode:         prompt-enforced compatibility mode")


async def execute(args: argparse.Namespace) -> int:
    input_path = args.input.expanduser().resolve()
    prompt_path = args.prompt.expanduser().resolve()
    schema_path = args.schema.expanduser().resolve()
    output_path = args.output.expanduser().resolve()

    schema = AnnotationSchema.load(schema_path)
    system_prompt, prompt_sha256 = load_system_prompt(prompt_path, schema.version)
    schema.validate_prompt_coverage(system_prompt)
    schema_sha256 = file_sha256(schema_path)
    dataset_sha256 = file_sha256(input_path)
    selected = select_queries(load_queries(input_path), args.query_id, args.limit)
    if not selected:
        raise RuntimeError("No queries remain after applying the requested selection.")

    if args.provider == "anthropic":
        supplemental_input_chars = len(
            json.dumps(schema.to_json_schema(), separators=(",", ":"), ensure_ascii=False)
        )
        # Sonnet 5's tokenizer plus structured-output grammar uses more tokens
        # than Barney's four-characters/token rule. This factor is deliberately
        # conservative relative to the observed one-query smoke test.
        characters_per_token = 2.65
    else:
        supplemental_input_chars = 0
        characters_per_token = 4.0

    metadata = build_run_metadata(
        args=args,
        selected=selected,
        dataset_sha256=dataset_sha256,
        prompt_sha256=prompt_sha256,
        schema_sha256=schema_sha256,
        schema_version=schema.version,
    )

    if args.dry_run:
        plan = plan_concurrency(
            system_prompt,
            selected,
            max_output_tokens=args.max_tokens,
            token_budget=args.token_budget,
            max_concurrency=args.max_concurrency,
            supplemental_input_chars=supplemental_input_chars,
            characters_per_token=characters_per_token,
        )
        print_plan(
            args=args,
            total_selected=len(selected),
            already_complete=0,
            pending=len(selected),
            plan=plan,
        )
        print("Dry run only; no API was contacted and no output files were created.")
        return 0

    with OutputStore(output_path) as store:
        manifest = store.prepare_manifest(metadata)
        completed_ids = store.successful_query_ids()
        pending = [query for query in selected if query.query_id not in completed_ids]
        plan = plan_concurrency(
            system_prompt,
            pending,
            max_output_tokens=args.max_tokens,
            token_budget=args.token_budget,
            max_concurrency=args.max_concurrency,
            supplemental_input_chars=supplemental_input_chars,
            characters_per_token=characters_per_token,
        )
        print_plan(
            args=args,
            total_selected=len(selected),
            already_complete=len(selected) - len(pending),
            pending=len(pending),
            plan=plan,
        )
        if not pending:
            print("All selected queries already have successful results.")
            import_path = store.write_import_bundle(manifest)
            print(f"Admin import bundle:       {import_path}")
            return 0

        config = BatchConfig(
            provider=args.provider,
            model=args.model,
            max_tokens=args.max_tokens,
            temperature=args.temperature,
            max_retries=args.max_retries,
            include_query_text=args.include_query_text,
            prompt_sha256=prompt_sha256,
        )
        run_started = utc_now()
        successes = 0
        failures = 0

        def on_result(record: dict[str, object], completed: int, total: int) -> None:
            nonlocal successes, failures
            store.append(record)
            if record["status"] == "ok":
                successes += 1
            else:
                failures += 1
            usage = record.get("usage", {})
            print(
                f"[{completed:>3}/{total}] {record['status']:<5} query={record['query_id']} "
                f"attempts={record['attempts']} tokens={usage.get('total_tokens', 0)}",
                flush=True,
            )

        async def invoke(provider: CompletionProvider) -> tuple[list[dict[str, object]], int]:
            results, aborted = await run_batch(
                provider=provider,
                queries=pending,
                system_prompt=system_prompt,
                schema=schema,
                concurrency=plan.concurrency,
                config=config,
                on_result=on_result,
            )
            return results, aborted

        if args.provider == "barney":
            base_url, api_key = connection_settings()
            try:
                from openai import AsyncOpenAI
            except ImportError as error:
                raise RuntimeError(
                    "The OpenAI SDK is not installed. Run `python -m pip install -e .` in llm_eval/."
                ) from error
            async with AsyncOpenAI(
                base_url=base_url,
                api_key=api_key,
                timeout=args.request_timeout,
                max_retries=0,
            ) as client:
                results, aborted = await invoke(
                    OpenAICompatibleProvider(client, json_mode=args.json_mode)
                )
        else:
            api_key = anthropic_api_key()
            try:
                from anthropic import AsyncAnthropic
            except ImportError as error:
                raise RuntimeError(
                    "The Anthropic SDK is not installed. Run `python -m pip install -e .` in llm_eval/."
                ) from error
            async with AsyncAnthropic(
                api_key=api_key,
                timeout=args.request_timeout,
                max_retries=0,
            ) as client:
                results, aborted = await invoke(AnthropicProvider(client))

        usage = TokenUsage()
        for result in results:
            values = result.get("usage", {})
            usage.add(
                TokenUsage(
                    prompt_tokens=int(values.get("prompt_tokens", 0)),
                    completion_tokens=int(values.get("completion_tokens", 0)),
                    total_tokens=int(values.get("total_tokens", 0)),
                    uncached_input_tokens=int(values.get("uncached_input_tokens", 0)),
                    cache_creation_input_tokens=int(
                        values.get("cache_creation_input_tokens", 0)
                    ),
                    cache_read_input_tokens=int(values.get("cache_read_input_tokens", 0)),
                )
            )
        manifest["updated_at"] = utc_now()
        manifest["last_run"] = {
            "started_at": run_started,
            "finished_at": utc_now(),
            "planned_concurrency": plan.concurrency,
            "estimated_tokens_per_request": plan.estimated_tokens_per_request,
            "estimated_tokens_in_flight": plan.estimated_tokens_in_flight,
            "requested": len(pending),
            "succeeded": successes,
            "failed": failures,
            "aborted_after_fatal_error": aborted,
            "usage": usage.as_dict(),
        }
        store.write_manifest(manifest)

        import_path = None
        if not failures and not aborted:
            import_path = store.write_import_bundle(manifest)

        print(
            f"Run complete: {successes} succeeded, {failures} failed, {aborted} aborted; "
            f"usage={usage.prompt_tokens:,} input + {usage.completion_tokens:,} output "
            f"= {usage.total_tokens:,} total tokens "
            f"({usage.cache_creation_input_tokens:,} cache-write, "
            f"{usage.cache_read_input_tokens:,} cache-read)."
        )
        if import_path is not None:
            print(f"Admin import bundle: {import_path}")
        return 1 if failures or aborted else 0


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    load_environment()
    try:
        return asyncio.run(execute(args))
    except KeyboardInterrupt:
        print("Interrupted. Successful JSONL rows are durable; rerun the same command to resume.", file=sys.stderr)
        return 130
    except Exception as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
