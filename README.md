# Clinical Query Taxonomy

A clinician-facing annotation platform for classifying de-identified queries submitted to a hospital LLM wrapper during routine care. The interface and server validation implement the 24-field **Clinician Query Annotation Codebook v2.1** in [`prompt.txt`](prompt.txt).

The application lives in `clinical_eval_platform/` and provides:

- breadth-first random assignment with three independent review slots per query;
- 40 initial queries plus optional clinician-requested batches of 10;
- exactly 24 forced-choice taxonomy fields;
- inline field rules and a searchable codebook;
- automatic enforcement of all hard consistency rules;
- debounced server autosave with one in-flight save per query, automatic retry with backoff, an unsynced-change indicator, a leave-page warning, and browser recovery for interrupted sessions;
- live admin coverage and field-level inter-rater reliability monitoring;
- secure import of privacy-preserving LLM annotations with live human–model concordance;
- searchable admin query inventory with per-query assignment and completion coverage;
- audited assignment release/reassignment controls and analysis-ready CSV export;
- a private-runtime dataset path for Vercel.

The separate [`llm_eval/`](llm_eval/) package runs the same 24-field semantic contract against either Anthropic's Claude API or the lab's self-hosted Barney endpoint. Its compact model prompt is hash-pinned and automatically checked against the canonical clinician codebook for every field, allowed value, and critical decision-rule family. The package also provides provider-specific structured output, token-budgeted asynchronous inference, validation, retry/backoff, exact usage accounting, and resumable Git-ignored JSONL output without coupling model access to the Vercel application.

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
- source specialty metadata (optional, admin export only): `specialty`, `speciality`, `asker_specialty`, `clinician_specialty`, or `role`.

Additional columns, including `phipii`, are preserved as source metadata boundaries and do not determine whether a non-empty query is imported. Empty query rows are skipped and counted without logging row contents.

Set `ANNOTATION_INPUT` to use another local path. Duplicate IDs and empty datasets fail the build.

To create an exactly reproducible sample without replacement, use the repository sampler. This example replaces the private source file with 100 records selected from its current contents using seed 42. The selected records remain in their original display order. Keep a recovery copy before using `--replace`.

```bash
cd clinical_eval_platform
node scripts/sample-dataset.mjs --input ../real_chat_sample.csv --output ../real_chat_sample.csv --count 100 --seed 42 --replace
```

The command uses a documented Mulberry32 generator and Fisher–Yates shuffle, so the same input order, count, and seed produce the same cohort across runs.

Each annotator receives 40 randomly selected queries initially. Assignment is breadth-first: queries with no assigned review are sampled before queries with one, then two, assigned reviewers. Ties within each coverage level use a deterministic seeded shuffle (seed 42). After finishing the current batch, an annotator may explicitly press **Add 10 more queries**; add-on batches are never assigned automatically. A rater can never receive the same query twice within a study run or receive more than 100 queries, and each query has at most three independent reviewers.

Coverage priority is based on assigned review slots, rather than completed annotations, so simultaneous reviewer sign-ins cannot overbook a subset of queries. Stalled assignments can be released or moved from the admin portal. For the 100-query study cohort, full coverage is 300 completed annotations. Deployments upgrading from the earlier two-review design preserve existing work, expand the database constraint safely, and add only each query's missing third slot.

## Configuration

Copy `clinical_eval_platform/.env.example` and set:

- `DATABASE_URL` (or `POSTGRES_URL`) for Postgres persistence;
- `EVAL_ACCESS_CODE` for annotator/API access;
- `ADMIN_PASSWORD` (and optionally `ADMIN_USER`) for the admin portal;

Production fails closed when either access code or admin password is missing. Local development can enter a clearly labeled browser-only demo mode when Postgres is absent.

## Unlisted access

The site ships with three crawler controls: page-level `noindex`/`nofollow` metadata, a disallow-all `robots.txt`, and an `X-Robots-Tag` header on every route. A direct link still works, but compliant search engines should not index or follow the site.

Crawler directives are not access control. For a link that can be revoked, enable Vercel Authentication under **Project → Settings → Deployment Protection** and create a Shareable Link for external annotators. Keep the application access code enabled as a second gate for the query APIs.

## Private Vercel dataset

Do not commit or place `real_chats.csv` in `public/`. Both Git and Vercel ignore files explicitly exclude the raw dataset and generated server data. For Vercel, create a **Private Blob** store, upload the approved dataset, and set its private URL as `ANNOTATION_BLOB_URL`. New Vercel connections use short-lived OIDC credentials with the supplied `BLOB_STORE_ID`; legacy connections can still use `BLOB_READ_WRITE_TOKEN`. The server retrieves the CSV at runtime and never exposes Blob credentials to the browser.

```bash
cd clinical_eval_platform
vercel link
vercel blob create-store rcq-annotation-data --access private --region iad1
vercel env pull .env.local
vercel blob put ../real_chat_sample.csv --pathname datasets/real-chats-2026-08-17.csv --access private
```

Copy the private URL returned by the upload into the Vercel project's `ANNOTATION_BLOB_URL` Production environment variable. Confirm that the connected store added `BLOB_STORE_ID`, then redeploy. At runtime, the app extracts the file pathname and retrieves it from that connected store, avoiding cross-store URL/credential mismatches. Use a new versioned pathname and update `ANNOTATION_BLOB_URL` when replacing a dataset so each study run has an unambiguous source.

The production runtime also needs `DATABASE_URL` (or `POSTGRES_URL`), `EVAL_ACCESS_CODE`, and `ADMIN_PASSWORD`. After deployment, `/admin` should label the source as **Active dataset** and show the expected query count. If it still says **Example data**, check that both Blob environment variables were applied to Production and redeploy once more.

Before storing any PHI, obtain institutional privacy/security approval and ensure the hosting plan, BAA, data residency, access controls, and connected database are all approved for that data. A private object URL alone is not a HIPAA compliance program. Prefer an institution-managed source if the dataset has not been formally de-identified.

## Vercel deployment

Under **Project Settings → Build and Deployment**, set the Vercel **Root Directory** to `clinical_eval_platform` and enable **Include source files outside of the Root Directory in the Build Step**. The latter makes the repository-level `prompt.txt` available when the application generates the in-portal codebook. Use the **Next.js** framework preset and leave the install, build, and output commands at their detected defaults.

Configure the following Production environment variables before data collection:

- `DATABASE_URL` (or `POSTGRES_URL`)
- `EVAL_ACCESS_CODE`
- `ADMIN_PASSWORD` and optionally `ADMIN_USER`
- `ANNOTATION_BLOB_URL` and the connected private store's `BLOB_STORE_ID` (or legacy `BLOB_READ_WRITE_TOKEN`)

After adding or changing environment variables, redeploy so they apply to the new deployment.

## Validation

```bash
cd clinical_eval_platform
npm test
npm run build
```

The admin portal is at `/admin`. It reports unanimous agreement and unweighted Fleiss' kappa for every field once all three reviews of a query are complete under the active codebook. Study progress, human-only IRR, and human–LLM concordance refresh automatically every 15 seconds; derived labels are shown but excluded from aggregate statistics.

### Importing an LLM evaluation run

After deploying the application changes, open `/admin` and find **Claude annotations and clinician concordance**. Choose the single portable file from the local Git-ignored `llm_eval/outputs/` directory, then press **Validate and import**:

- `claude_predictions.import.json`

The evaluator still keeps its JSONL and manifest internally so interrupted batches can resume safely, but it automatically packages both into this one import file after a complete run. The admin endpoint is protected by the same Basic Authentication as the rest of `/admin`. It validates the manifest and codebook version, matches every record to the active dataset by stable ID and SHA-256 query hash, requires the exact normalized 24-field schema, and rejects bundles that contain query text. Only model labels, query IDs/hashes, limited response metadata, and the sanitized run manifest are stored in Neon. Re-importing the same run replaces it transactionally.

The model is never treated as an additional clinician in the IRR calculation. The separate human–LLM panel reports descriptive field agreement between each completed clinician annotation and the fixed model annotation for the same query. Query-level model labels load only when an administrator requests them.

Administrators can release an assignment back to the shared pool or move it to another registered reviewer. Saved annotations are never transferred between reviewer identities: changing an assignment with partial or completed work requires confirmation and permanently deletes that source annotation. Every move or release is recorded in `admin_assignment_events`. Open reviewer workspaces synchronize assignment changes within 30 seconds, while the server rejects saves to removed assignments immediately; saves and assignment changes for the same query are serialized on a per-query database lock, so a save can never slip in between an administrator's check and the reassignment. Removing all of a reviewer's assignments does not trigger another automatic initial batch; the reviewer must explicitly request the next increment of 10.

The admin export includes query text, optional source specialty metadata, all 24 labels in codebook order, completion state, notes, and audit timestamps.

## License

GNU AGPL v3. See [`LICENSE`](LICENSE).
