# Clinician Review Platform

This is the blinded clinician rating app used for the Real Clinical Queries (RCQ) stage of the manuscript **General-Purpose Large Language Models Outperform Specialized Clinical AI Tools on Medical Benchmarks**.

The app lets clinician raters review de-identified clinical queries and blinded model responses on a structured 1-4 rubric:

- Clinical correctness
- Completeness
- Safety / harm avoidance
- Clarity
- Binary harmful-content and hallucination flags

Ratings autosave to Postgres. Admin routes export reviewer data and preserve the mapping from blinded model IDs to model names.

## Local Development

```bash
npm install
cp .env.example .env
npm run dev
```

Set one database connection string in `.env`:

```bash
DATABASE_URL=
# or POSTGRES_URL=
```

Optional settings:

```bash
ADMIN_USER=admin
ADMIN_PASSWORD=
EVAL_ACCESS_CODE=
NEXT_PUBLIC_DEFAULT_ASSIGNMENT_COUNT=150
```

If you want the initial assignment size to mirror the manuscript setup exactly, keep `NEXT_PUBLIC_DEFAULT_ASSIGNMENT_COUNT=150` because `100 questions x 6 models x 3 reviews / 12 raters = 150` response-items per rater.

## Local Benchmark Input

Place a private `query_responses.csv` or `query_responses.xlsx` in this directory when running the app locally. The file should contain:

- An optional ID column: `index`, `id`, `query_id`, or `question_id`
- A required query column: `question`, `query`, or `prompt`
- One response column per model

`npm run dev` and `npm run build` run `scripts/build-benchmark.mjs`, which creates:

- `public/benchmark.json`: blinded benchmark payload for raters.
- `data/model_map.json`: admin-only model ID mapping.
- `data/benchmark_questions.json`: question IDs used for assignment sampling.

These files are ignored by git because RCQ queries and model outputs are not public release artifacts.

## Rater Flow

- `/` starts or resumes a rater session.
- `/eval` assigns model responses for review and autosaves ratings.
- Model identities are blinded as `Model_A`, `Model_B`, and so on.
- Assignment slots target three independent reviews per model response.

## Admin Flow

- `/admin` shows benchmark state, model mapping, rater progress, export links, and reset controls.
- `/api/admin/export` returns all saved ratings as CSV.
- `/api/admin/export?benchmarkId=...` exports one benchmark version.
- `/api/admin/reset` clears saved evaluations and assignments for a benchmark.

Set `ADMIN_PASSWORD` before deploying so `/admin` and `/api/admin/*` are protected with HTTP Basic Auth.

## Deployment

1. Import the repository into Vercel.
2. Set `DATABASE_URL` or `POSTGRES_URL`.
3. Set `ADMIN_PASSWORD`.
4. Provide `EVAL_ACCESS_CODE` if rater access should be gated.
5. Build with the private, release-approved benchmark input available in the deployment environment.
