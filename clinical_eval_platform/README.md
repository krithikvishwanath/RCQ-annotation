# Clinical Query Taxonomy application

See the repository-level [`README.md`](../README.md) for setup, data schema, secure Vercel ingestion, and operations guidance.

Quick start:

```bash
npm install
cp .env.example .env
npm run dev
```

`npm run dev` prepares the ignored server-only dataset and starts the Next.js app. Without Postgres, development falls back to a browser-only example mode; production requires Postgres, `EVAL_ACCESS_CODE`, and `ADMIN_PASSWORD`.
