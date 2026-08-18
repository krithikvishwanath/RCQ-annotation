# RCQ LLM evaluation

This sibling package applies the same 24-field taxonomy used by clinician reviewers to every query through either the lab's self-hosted **Barney** model or the **Claude API**. It runs separately from `clinical_eval_platform/`; neither Vercel nor the browser application calls either model endpoint.

The entire folder is excluded by the repository-level `.vercelignore`. Keep API credentials in a local/cluster `.env`; do not add them to the Vercel project.

The repository-level `prompt.txt` remains the canonical clinician codebook. By default, the runner uses `llm_eval/prompt_compact.txt`, a versioned semantic compression that preserves the same field definitions, precedence rules, boundary cases, hard constraints, and calibration examples while removing human-facing and output-format duplication. Each request adds only:

```text
Question:  <verbatim query text>
```

The model must return one JSON object containing exactly the same 24 fields and allowed values as the clinician portal. Claude uses native JSON Schema output; Barney uses prompt enforcement with optional OpenAI-compatible JSON mode. Every response is independently validated against the checked-in `annotation_schema.json`, which is tested against the web application's taxonomy so CI fails if the two contracts drift.

`prompt_contract.json` pins both prompt hashes and pairs critical-rule anchors across the human and compact editions. Tests also require every schema field and exact categorical value to occur in the compact prompt. Therefore any edit to the clinician codebook requires an intentional review and update of the model edition. The run manifest records the actual model-prompt hash, so outputs from the full and compact prompts cannot be mixed. For a deliberate comparison against the verbatim clinician codebook, pass `--prompt ../prompt.txt` and choose a distinct output path.

## Claude setup and smoke test

Create `llm_eval/.env` (or use the repository-level `.env`) with:

```dotenv
ANTHROPIC_API_KEY=your_anthropic_api_key
```

Then install and send exactly one query:

```bash
cd RCQ-annotation/llm_eval
python3 -m venv .venv
source .venv/bin/activate
python -m pip install .
rcq-llm-eval --provider anthropic --limit 1 --output outputs/claude_smoke.jsonl
```

The Claude default is the pinned `claude-sonnet-5` model ID. Its provider-default sampling settings are used because Sonnet 5 does not accept temperature overrides. Extended thinking is explicitly disabled for this bounded classification workload so the model cannot spend the 1,200-token output allowance on hidden reasoning before producing the required JSON. The shared system prompt uses Anthropic's five-minute ephemeral prompt cache; exact uncached, cache-write, cache-read, and output usage is recorded. These settings are also included in the run fingerprint. Use `--model` to make an intentional model change. Output goes to `outputs/claude_predictions.jsonl` by default and is never mixed with Barney output.

The Claude planner includes the serialized JSON Schema and uses a conservative Sonnet-specific token ratio. With the current compact prompt and dataset it estimates about 11,977 tokens per request and plans four concurrent requests (about 47,908 tokens in flight) under the 50,000-token ceiling; raise `--token-budget` only when your Anthropic account limits and study budget support it.

Only de-identified queries should be submitted unless your institution has separately approved the account and workflow for sensitive data. Query text is not duplicated into local result files unless `--include-query-text` is explicitly set.

## BigPurple setup

Barney is reachable only from inside the cluster. On a compute node:

```bash
cd RCQ-annotation/llm_eval
python3 -m venv .venv
source .venv/bin/activate
python -m pip install .
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
rcq-llm-eval --provider barney --dry-run
```

For the current 100-query dataset and compact v2.1 prompt, the default Barney planner estimates approximately 7,457 tokens per request and chooses six concurrent requests: roughly 44,742 tokens in flight, below the 50,000-token fair-use target. The calculation uses the longest pending query, `max_tokens`, and the lab's conservative four-characters-per-token approximation.

## Run

```bash
rcq-llm-eval --provider barney
```

Defaults:

- provider/model: `barney` / `Barney`;
- input: repository-level `real_chat_sample.csv`;
- prompt: `llm_eval/prompt_compact.txt` (semantic contract pinned to repository-level `prompt.txt`);
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

# Compare the verbatim clinician prompt without mixing it into compact-prompt output.
rcq-llm-eval --provider anthropic --prompt ../prompt.txt --limit 5 --output outputs/claude_full_prompt_smoke.jsonl

# One or more stable query IDs.
rcq-llm-eval --query-id 36978 --query-id 36969 --output outputs/barney_selected.jsonl

# Ask for OpenAI-compatible JSON mode only if the current Barney server supports it.
rcq-llm-eval --json-mode --output outputs/barney_json_mode.jsonl
```

## Tests

After every complete run, the evaluator also writes one portable admin-upload file next to the resumable outputs, for example `outputs/claude_predictions.import.json`. Upload only that bundle in the web admin. The JSONL and manifest remain separate internally so interrupted batches can resume without losing successful requests.

The tests do not contact Barney or Anthropic:

```bash
PYTHONPATH=src python -m unittest discover -s tests -v
```
