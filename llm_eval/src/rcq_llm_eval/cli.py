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
from .schema import AnnotationSchema
from .storage import OutputStore


LLM_EVAL_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = LLM_EVAL_ROOT.parent
DEFAULT_INPUT = REPO_ROOT / "real_chat_sample.csv"
DEFAULT_PROMPT = REPO_ROOT / "prompt.txt"
DEFAULT_SCHEMA = LLM_EVAL_ROOT / "annotation_schema.json"
DEFAULT_OUTPUT = LLM_EVAL_ROOT / "outputs" / "barney_predictions.jsonl"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Annotate RCQ queries through Barney with bounded asynchronous concurrency."
    )
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--prompt", type=Path, default=DEFAULT_PROMPT)
    parser.add_argument("--schema", type=Path, default=DEFAULT_SCHEMA)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--model", default="Barney")
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
    parser.add_argument("--temperature", type=float, default=0.0)
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
        help="Send response_format=json_object if the current Barney server supports it.",
    )
    parser.add_argument(
        "--include-query-text",
        action="store_true",
        help="Duplicate query text into output JSONL (off by default for data minimization).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate files and print the token/concurrency plan without contacting Barney.",
    )
    args = parser.parse_args(argv)
    if args.limit is not None and args.limit < 1:
        parser.error("--limit must be positive.")
    if args.max_retries < 0:
        parser.error("--max-retries cannot be negative.")
    if args.request_timeout <= 0:
        parser.error("--request-timeout must be positive.")
    if not 0 <= args.temperature <= 2:
        parser.error("--temperature must be between 0 and 2.")
    if not str(args.model).strip():
        parser.error("--model cannot be empty.")
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
        "dataset_sha256": dataset_sha256,
        "selected_query_ids": [query.query_id for query in selected],
        "prompt_sha256": prompt_sha256,
        "schema_sha256": schema_sha256,
        "model": args.model,
        "max_tokens": args.max_tokens,
        "temperature": args.temperature,
        "json_mode": args.json_mode,
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
    if args.json_mode:
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
    schema_sha256 = file_sha256(schema_path)
    dataset_sha256 = file_sha256(input_path)
    selected = select_queries(load_queries(input_path), args.query_id, args.limit)
    if not selected:
        raise RuntimeError("No queries remain after applying the requested selection.")

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
        )
        print_plan(
            args=args,
            total_selected=len(selected),
            already_complete=0,
            pending=len(selected),
            plan=plan,
        )
        print("Dry run only; Barney was not contacted and no output files were created.")
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
            return 0

        base_url, api_key = connection_settings()
        try:
            from openai import AsyncOpenAI
        except ImportError as error:
            raise RuntimeError(
                "The OpenAI SDK is not installed. Run `python -m pip install -e .` in llm_eval/."
            ) from error

        config = BatchConfig(
            model=args.model,
            max_tokens=args.max_tokens,
            temperature=args.temperature,
            max_retries=args.max_retries,
            json_mode=args.json_mode,
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

        async with AsyncOpenAI(
            base_url=base_url,
            api_key=api_key,
            timeout=args.request_timeout,
            max_retries=0,
        ) as client:
            results, aborted = await run_batch(
                client=client,
                queries=pending,
                system_prompt=system_prompt,
                schema=schema,
                concurrency=plan.concurrency,
                config=config,
                on_result=on_result,
            )

        usage = TokenUsage()
        for result in results:
            values = result.get("usage", {})
            usage.add(
                TokenUsage(
                    prompt_tokens=int(values.get("prompt_tokens", 0)),
                    completion_tokens=int(values.get("completion_tokens", 0)),
                    total_tokens=int(values.get("total_tokens", 0)),
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

        print(
            f"Run complete: {successes} succeeded, {failures} failed, {aborted} aborted; "
            f"usage={usage.prompt_tokens:,} input + {usage.completion_tokens:,} output "
            f"= {usage.total_tokens:,} total tokens."
        )
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
