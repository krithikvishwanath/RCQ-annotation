# Clinical Query Taxonomy

A clinician-facing annotation platform for classifying de-identified queries submitted to a hospital LLM wrapper during routine care. The interface and server validation implement the 25-field **Clinician Query Annotation Codebook v1** in [`prompt.txt`](prompt.txt).

The application lives in `clinical_eval_platform/` and provides:

- query-level assignment with three independent review slots;
- exactly 25 forced-choice taxonomy fields;
- inline field rules and a searchable codebook;
- automatic enforcement of all hard consistency rules;
- debounced server autosave plus browser recovery for interrupted sessions;
- admin coverage monitoring and analysis-ready CSV export;
- a private-runtime dataset path for Vercel.

## Local development

```bash
cd clinical_eval_platform
npm install
cp .env.example .env
npm run dev
```

The app uses four source-controlled example queries when no local data file exists. Add `real_chats.csv` at the repository root or inside `clinical_eval_platform/` to use the study dataset locally. It is explicitly ignored by Git at both levels.

The input is UTF-8 CSV. Recognized columns:

- query text (required): `question`, `query`, `prompt`, `query_text`, `chat`, `message`, `user_message`, or `text`;
- stable ID (recommended): `id`, `index`, `row_index`, `query_id`, `question_id`, or `chat_id`;
- asker specialty (optional): `specialty`, `speciality`, `asker_specialty`, `clinician_specialty`, or `role`.

Additional columns, including `phipii`, are preserved as source metadata boundaries and do not determine whether a non-empty query is imported. Empty query rows are skipped and counted without logging row contents.

Set `ANNOTATION_INPUT` to use another local path. Duplicate IDs and empty datasets fail the build.

## Configuration

Copy `clinical_eval_platform/.env.example` and set:

- `DATABASE_URL` (or `POSTGRES_URL`) for Postgres persistence;
- `EVAL_ACCESS_CODE` for annotator/API access;
- `ADMIN_PASSWORD` (and optionally `ADMIN_USER`) for the admin portal;
- `NEXT_PUBLIC_DEFAULT_ASSIGNMENT_COUNT` for assignment batch size.

Production fails closed when either access code or admin password is missing. Local development can enter a clearly labeled browser-only demo mode when Postgres is absent.

## Unlisted access

The site ships with three crawler controls: page-level `noindex`/`nofollow` metadata, a disallow-all `robots.txt`, and an `X-Robots-Tag` header on every route. A direct link still works, but compliant search engines should not index or follow the site.

Crawler directives are not access control. For a link that can be revoked, enable Vercel Authentication under **Project → Settings → Deployment Protection** and create a Shareable Link for external annotators. Keep the application access code enabled as a second gate for the query APIs.

## Private Vercel dataset

Do not commit or place `real_chats.csv` in `public/`. Both Git and Vercel ignore files explicitly exclude the raw dataset and generated server data. For Vercel, create a **Private Blob** store, upload the approved dataset, and set its private URL as `ANNOTATION_BLOB_URL`. Connecting the store supplies `BLOB_READ_WRITE_TOKEN`; the server retrieves the CSV at runtime and never exposes the Blob URL or token to the browser.

```bash
vercel blob create-store rcq-annotation-data --access private --region iad1
vercel blob put ../real_chats.csv --pathname datasets/real_chats.csv --access private
```

Before storing any PHI, obtain institutional privacy/security approval and ensure the hosting plan, BAA, data residency, access controls, and connected database are all approved for that data. A private object URL alone is not a HIPAA compliance program. Prefer an institution-managed source if the dataset has not been formally de-identified.

## Validation

```bash
cd clinical_eval_platform
npm test
npm run build
```

The admin portal is at `/admin`. Its export includes query text, optional specialty, all 25 labels in codebook order, completion state, notes, and audit timestamps.

## License

GNU AGPL v3. See [`LICENSE`](LICENSE).
