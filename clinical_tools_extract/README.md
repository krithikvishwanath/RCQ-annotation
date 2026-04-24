# Benchmark Pipeline

This directory contains the command-line pipeline used to generate and score model responses for the manuscript **General-Purpose Large Language Models Outperform Specialized Clinical AI Tools on Medical Benchmarks**.

The pipeline supports:

- Frontier LLM generation through API providers.
- Importing pre-collected outputs for systems such as OpenEvidence, UpToDate Expert AI, and Google Search AI Overview.
- MedQA answer extraction and correctness scoring.
- HealthBench rubric scoring with either a single grader or a panel-majority grader.
- Exporting a merged response matrix for blinded clinician review.

## Setup

```bash
cd clinical_tools_extract
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

Set only the credentials needed for the providers you run:

```bash
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_API_KEY=
```

## Expected Local Layout

The paths below are relative to this directory and are intentionally ignored by git:

```text
data/benchmarks/medqa_500.jsonl
data/benchmarks/healthbench_500.jsonl
data/runs/model_registry.json
data/runs/<model>/<benchmark>/raw.jsonl
data/runs/<model>/<benchmark>/processed.jsonl
data/runs/<model>/<benchmark>/scored.json
```

For the manuscript configuration, use the three frontier API models directly and point the manual/browser-only systems at local source files in `data/runs/model_registry.json`. The pipeline matches `source_files` against benchmark keys such as `medqa`, `healthbench`, and `rcq`.

```jsonc
[
  {
    "model_id": "openevidence-web",
    "provider": "openevidence",
    "generation_mode": "import_from_source",
    "source_files": {
      "medqa": "data/runs/openevidence-web/medqa/raw.jsonl",
      "healthbench": "data/runs/openevidence-web/healthbench/raw.jsonl",
      "rcq": "data/runs/openevidence-web/rcq/raw.jsonl"
    }
  },
  {
    "model_id": "uptodate-ai",
    "provider": "uptodate",
    "generation_mode": "import_from_source",
    "source_files": {
      "medqa": "data/runs/uptodate-ai/medqa/raw.jsonl",
      "healthbench": "data/runs/uptodate-ai/healthbench/raw.jsonl",
      "rcq": "data/runs/uptodate-ai/rcq/raw.jsonl"
    }
  },
  {
    "model_id": "google-ai-overview",
    "provider": "google_ai_overview",
    "generation_mode": "import_from_source",
    "source_files": {
      "rcq": "data/runs/google-ai-overview/rcq/raw.jsonl"
    }
  }
]
```

## Generation

Generate answers for an API model:

```bash
python evaluation_pipeline.py generate \
  --input data/benchmarks/medqa_500.jsonl \
  --model openai-gpt-5-2 \
  --output data/runs/openai-gpt-5-2/medqa/raw.jsonl \
  --enable-search \
  --allow-error-rows \
  --checkpoint-every 25
```

## Scoring

Score MedQA answers:

```bash
python evaluation_pipeline.py medqa \
  --input data/runs/openai-gpt-5-2/medqa/raw.jsonl \
  --output data/runs/openai-gpt-5-2/medqa/processed.jsonl
```

Score HealthBench answers with the default panel:

```bash
python evaluation_pipeline.py healthbench \
  --input data/runs/openai-gpt-5-2/healthbench/raw.jsonl \
  --output data/runs/openai-gpt-5-2/healthbench/scored.json \
  --model-registry data/runs/model_registry.json
```

## RCQ Response Matrix

To prepare the manuscript-style blinded clinician review matrix, place the private RCQ input workbook locally and write the merged output to ignored storage:

```bash
python evaluation_pipeline.py generate-benchmark-csv \
  --input data/benchmarks/RCQ.xlsx \
  --output data/runs/RCQ_6model_outputs.csv \
  --enable-search \
  --allow-error-rows \
  --checkpoint-every 25
```


## Useful Defaults

- Generation temperature defaults to `0.0`.
- Generation seed defaults to `62` when the provider supports seeding.
- HealthBench panel models default to Claude Opus 4.6, Gemini 3.1 Pro Preview, and GPT-5.2.
- API search tooling can be enabled with `--enable-search`.
- Long runs can checkpoint with `--checkpoint-every`.
