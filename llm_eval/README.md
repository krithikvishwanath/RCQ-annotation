# RCQ Barney evaluation

This sibling package applies the same 24-field taxonomy used by clinician reviewers to every query through the lab's self-hosted **Barney** model. It runs separately from `clinical_eval_platform/`; neither Vercel nor the browser application calls the cluster endpoint.

The entire folder is excluded by the repository-level `.vercelignore`. Keep the Barney URL and NetID in the local/cluster `.env`; do not add those variables to the Vercel project.

The runner uses the repository-level `prompt.txt` verbatim as its one canonical system prompt. Each request adds only:

```text
Question:  <verbatim query text>
```

The model must return one JSON object containing exactly the same 24 fields and allowed values as the clinician portal. The checked-in `annotation_schema.json` is tested against the web application's taxonomy, so CI fails if the two contracts drift.

## BigPurple setup

Barney is reachable only from inside the cluster. On a compute node:

```bash
cd RCQ-annotation/llm_eval
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
mkdir -p outputs
```

Obtain the current gateway URL using the lab's `scripts/kimi_url.sh` helper with `KIMI_PORT=8001`. Add these values to the existing `.env` at the **repository root** (do not overwrite other application settings):

```dotenv
OPENAI_BASE_URL=http://current-head-node:8001/v1
OPENAI_API_KEY=your_nyu_netid
```

The runner refuses port `8000`, placeholder credentials, and URLs without `/v1`. The API key is never written to outputs or logs. Port `8001` and a real NetID are required so usage appears under the correct caller on the Barney dashboard.

The private `real_chat_sample.csv` is not in Git, so transfer it to the repository root on BigPurple through the approved institutional route before running. Do not place it in this package or commit it.

## Validate without sending requests

From `llm_eval/`:

```bash
rcq-llm-eval --dry-run
```

For the current 100-query dataset and v2.1 prompt, the default planner estimates approximately 9,942 tokens per request and chooses five concurrent requests: roughly 49,710 tokens in flight, below the 50,000-token fair-use target. The calculation uses the longest pending query, `max_tokens`, and the lab's conservative four-characters-per-token approximation.

## Run

```bash
rcq-llm-eval
```

Defaults:

- model: `Barney`;
- input: repository-level `real_chat_sample.csv`;
- prompt: repository-level `prompt.txt`;
- output: `llm_eval/outputs/barney_predictions.jsonl`;
- maximum completion: 1,200 tokens;
- token budget: 50,000 tokens in flight;
- worker ceiling: 16, automatically reduced by the token planner;
- temperature: 0;
- retries: four, with exponential backoff and jitter.

Do not combine Slurm arrays with this runner. It already parallelizes requests inside one process; multiple array tasks multiply the true concurrency and can exceed the shared budget. A single optional job script is provided:

```bash
mkdir -p outputs
sbatch slurm/run_barney_eval.sbatch
```

If active cluster usage is known, the budget can be changed explicitly—for example, `--token-budget 70000`. The runner still applies `--max-concurrency` as an independent ceiling.

## Output and resumption

Each successful JSONL row contains:

- stable `query_id` and a query-text SHA-256 hash;
- `annotation`, containing exactly the 24 model-produced fields;
- prompt/model/response identifiers;
- strict, fenced, or extracted JSON parse mode;
- attempts, latency, finish reason, and exact API-reported token usage.

Query text is excluded from output by default; use `--include-query-text` only when duplication is required. Invalid JSON and invalid field values are retried using the exact same prompt. HTTP 408/409/429 and 5xx responses back off exponentially. Authentication and request-shape errors stop the batch early so a bad configuration does not generate 100 failed calls.

Results are appended and flushed after every query. Rerunning the same command skips successful IDs and retries failures. A companion manifest prevents accidentally mixing outputs from different datasets, prompts, schemas, models, or generation settings. Choose a new `--output` path for a genuinely different run.

The output directory, JSONL results, manifests, lock files, `.env`, and raw query CSV are Git-ignored.

Useful options:

```bash
# Five-query smoke test; use a separate output so it cannot mix with the full run.
rcq-llm-eval --limit 5 --output outputs/barney_smoke.jsonl

# One or more stable query IDs.
rcq-llm-eval --query-id 36978 --query-id 36969 --output outputs/barney_selected.jsonl

# Ask for OpenAI-compatible JSON mode only if the current Barney server supports it.
rcq-llm-eval --json-mode --output outputs/barney_json_mode.jsonl
```

## Tests

The tests do not contact Barney:

```bash
PYTHONPATH=src python -m unittest discover -s tests -v
```
