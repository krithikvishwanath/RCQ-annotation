# Clinical Query Taxonomy application

See the repository-level [`README.md`](../README.md) for setup, data schema, secure Vercel ingestion, and operations guidance.

Quick start:

```bash
npm install
cp .env.example .env
npm run dev
```

`npm run dev` prepares the ignored server-only dataset and starts the Next.js app. Without Postgres, development falls back to a browser-only example mode; production requires Postgres, `EVAL_ACCESS_CODE`, and `ADMIN_PASSWORD`.

The protected `/admin` dashboard refreshes study progress, human-only IRR, and human–LLM concordance every 15 seconds. To attach a model run, import `../llm_eval/outputs/claude_predictions.import.json` through the **Claude annotations and clinician concordance** panel. The evaluator generates this portable file from its resumable JSONL and manifest automatically. The server rejects embedded query text and persists only validated labels and run metadata in Postgres.

## Annotation keyboard shortcuts

The annotation workspace includes a shortcut guide under **Shortcuts** (or `?`). Use `J`/`K` to move between fields, the number shown on a choice to select it, `Y`/`N` for binary fields, and `[`/`]` to move between sections. Keyboard answers advance focus to the next field. Shortcuts are suspended while typing in notes or search fields; `J`/`K` remains available to leave a dropdown.
