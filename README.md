# Clinical LLM Benchmarks

Code accompanying the manuscript:

**General-Purpose Large Language Models Outperform Specialized Clinical AI Tools on Medical Benchmarks**

This repository contains the evaluation pipeline and blinded clinician review platform used for the manuscript. It is prepared as a public code repository: local result files, protected clinical queries, generated benchmark bundles, API credentials, build artifacts, and local paths are intentionally excluded.

## Manuscript Overview

The study compares two specialized clinical AI tools, OpenEvidence and UpToDate Expert AI, against three frontier general-purpose LLMs: GPT-5.2, Gemini 3.1 Pro Preview, and Claude Opus 4.6. The Real Clinical Queries (RCQ) evaluation also includes Google Search AI Overview as a real-world control.

For MedQA and HealthBench, the manuscript benchmark matrix is five models wide: GPT-5.2, Gemini 3.1 Pro Preview, Claude Opus 4.6, OpenEvidence, and UpToDate Expert AI. For RCQ, a sixth column is added for Google Search AI Overview.

The evaluation has three stages:

1. **MedQA:** 500 USMLE-style questions sampled with seed 62.
2. **HealthBench:** 500 single-turn HealthBench prompts sampled with seed 62.
3. **Real Clinical Queries:** 100 de-identified clinician queries from live clinical LLM use, reviewed by 12 blinded U.S. clinicians across clinical correctness, completeness, safety/harm avoidance, and clarity.

In the manuscript version used to prepare this README, frontier LLMs outperformed the specialized clinical tools across all three evaluations. RCQ review produced 1,800 model-question annotations before refusal exclusions.

## Repository Layout

```text
clinical_tools_extract/
  evaluation_pipeline.py       # model generation, MedQA scoring, HealthBench scoring
  rerun_failed_healthbench.py   # helper for targeted HealthBench regrading
  requirements.txt             # Python dependencies for the pipeline

clinical_eval_platform/
  app/                          # Next.js blinded clinician rating interface
  scripts/build-benchmark.mjs   # converts a local response matrix into blinded app JSON
  lib/server/                   # Postgres schema and persistence helpers
  .env.example                  # deployment/runtime configuration template
```

## Data Availability

MedQA and HealthBench are public benchmarks. The exact 500-item subsets used in the manuscript can be reproduced with the sampling seed described in the Online Methods.

The RCQ benchmark is not included in this repository. It was derived from de-identified clinician queries collected under NYU Langone IRB protocol i23-00510 and is not publicly released because it originated in a clinical environment and remains subject to institutional review and data use restrictions.

Source data for manuscript figures should only be added here after release review. The `.gitignore` is intentionally conservative so private inputs and generated outputs stay local by default.

## Benchmark Pipeline

Install the Python dependencies:

```bash
cd clinical_tools_extract
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python evaluation_pipeline.py --help
```

Set only the API keys needed for the models you run:

```bash
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_API_KEY=
```

Example frontier-model generation command:

```bash
python evaluation_pipeline.py generate \
  --input data/benchmarks/medqa_500.jsonl \
  --model openai-gpt-5-2 \
  --output data/runs/openai-gpt-5-2/medqa/raw.jsonl \
  --enable-search \
  --allow-error-rows \
  --checkpoint-every 25
```

The manuscript used deterministic generation (`temperature=0.0`, seed `62` when supported) with search enabled for the frontier API models. OpenEvidence, UpToDate Expert AI, and Google Search AI Overview were collected outside the public repo and should be brought in here only as pre-collected local outputs referenced from `data/runs/model_registry.json`.

The `data/` directory is ignored. Use it for local benchmark subsets, pre-collected model outputs, model registries, and scoring products. This public repo does not include browser automation for OpenEvidence, UpToDate, or Google Search AI Overview retrieval.

## Clinician Review Platform

The blinded review app lives in `clinical_eval_platform/`.

```bash
cd clinical_eval_platform
npm install
cp .env.example .env
npm run dev
```

For RCQ-style review, provide a local `query_responses.csv` or `query_responses.xlsx` with a query column and one response column per model. In the manuscript configuration that means six response columns: GPT-5.2, Gemini 3.1 Pro Preview, Claude Opus 4.6, OpenEvidence, UpToDate Expert AI, and Google Search AI Overview. The build step creates:

- `public/benchmark.json`: blinded rater-facing benchmark bundle.
- `data/model_map.json`: admin-only mapping from blinded model IDs to real model names.
- `data/benchmark_questions.json`: question index used for assignment sampling.

These generated files are ignored because they may contain private clinical queries or model outputs.

## Citation

Citation details will be added after publication.
