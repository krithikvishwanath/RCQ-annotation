# Clinical LLM Benchmarks

Code accompanying the paper:

**General-purpose large language models outperform specialized clinical AI tools on medical benchmarks**
*Nature Medicine* (2026). https://doi.org/10.1038/s41591-026-04431-5

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


Set API keys: 

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

## License

The source code in this repository is licensed under GNU AGPL v3.

Unless otherwise noted, non-code materials such as figures, diagrams, and documentation are licensed under Creative Commons Attribution 4.0 International (CC BY 4.0).

Please cite the associated paper if you use this repository in academic work.

## Citation

If you use this code, please cite:

> Vishwanath, K., Alyakin, A., Ghosh, M., Hage, A., Neifert, S. N., Orillac, C., Mandelberg, N. J., Khan, H. A., Lee, J. V., Yao, J. J., Small, W. R., Varma, A., Hewitt, D. B., Aphinyanaphongs, Y., Alber, D. A. & Oermann, E. K. General-purpose large language models outperform specialized clinical AI tools on medical benchmarks. *Nature Medicine* (2026). https://doi.org/10.1038/s41591-026-04431-5

```bibtex
@article{vishwanath2026general,
  title   = {General-purpose large language models outperform specialized clinical AI tools on medical benchmarks},
  author  = {Vishwanath, Krithik and Alyakin, Anton and Ghosh, Mrigayu and Hage, Ali and Neifert, Sean N. and Orillac, Cordelia and Mandelberg, Nataniel J. and Khan, Hammad A. and Lee, Jin Vivian and Yao, Jie J. and Small, William Robert and Varma, Aakaash and Hewitt, D. Brock and Aphinyanaphongs, Yindalon and Alber, Daniel Alexander and Oermann, Eric Karl},
  journal = {Nature Medicine},
  year    = {2026},
  doi     = {10.1038/s41591-026-04431-5},
  url     = {https://doi.org/10.1038/s41591-026-04431-5}
}
```
