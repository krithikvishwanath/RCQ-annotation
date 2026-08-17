import { getSql } from "./db";
import { getDataset } from "./dataset";
import { REQUIRED_REVIEWS_PER_QUERY } from "../study-config";

let schemaPromise;

export async function ensureSchema() {
  if (schemaPromise) return schemaPromise;

  schemaPromise = initializeSchema().catch((error) => {
    schemaPromise = undefined;
    throw error;
  });
  return schemaPromise;
}

async function initializeSchema() {
  const sql = getSql();

  await sql`
    CREATE TABLE IF NOT EXISTS raters (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS annotations (
      rater_id uuid NOT NULL REFERENCES raters(id) ON DELETE CASCADE,
      dataset_id text NOT NULL,
      question_id text NOT NULL,
      codebook_version text NOT NULL,
      labels jsonb NOT NULL DEFAULT '{}'::jsonb,
      notes text NOT NULL DEFAULT '',
      is_complete boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (rater_id, dataset_id, question_id),
      CONSTRAINT annotations_labels_object CHECK (jsonb_typeof(labels) = 'object'),
      CONSTRAINT annotations_notes_length CHECK (char_length(notes) <= 4000)
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS annotations_dataset_idx
    ON annotations (dataset_id, question_id)
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS annotations_rater_idx
    ON annotations (rater_id, dataset_id)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS question_review_slots (
      benchmark_id text NOT NULL,
      question_id text NOT NULL,
      slot smallint NOT NULL CHECK (slot >= 0 AND slot < 2),
      rater_id uuid REFERENCES raters(id) ON DELETE SET NULL,
      assigned_at timestamptz,
      last_activity_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (benchmark_id, question_id, slot)
    )
  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS question_review_slots_unique_rater
    ON question_review_slots (benchmark_id, question_id, rater_id)
    WHERE rater_id IS NOT NULL
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS question_review_slots_rater_idx
    ON question_review_slots (rater_id, benchmark_id)
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS benchmark_state (
      benchmark_id text PRIMARY KEY,
      run_version int NOT NULL DEFAULT 1,
      reset_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const dataset = await getDataset();
  const datasetId = String(dataset?.datasetId || "").trim();
  const questionIds = Array.isArray(dataset?.questions)
    ? dataset.questions.map((question) => String(question?.id || "").trim()).filter(Boolean)
    : [];

  if (!datasetId || !questionIds.length) return;

  await sql`
    INSERT INTO question_review_slots (benchmark_id, question_id, slot)
    SELECT ${datasetId}, q.question_id, slots.slot
    FROM unnest(${sql.array(questionIds)}::text[]) AS q(question_id)
    CROSS JOIN generate_series(0, ${REQUIRED_REVIEWS_PER_QUERY - 1}) AS slots(slot)
    ON CONFLICT (benchmark_id, question_id, slot) DO NOTHING
  `;

  await sql`
    INSERT INTO benchmark_state (benchmark_id, run_version, updated_at)
    VALUES (${datasetId}, 1, now())
    ON CONFLICT (benchmark_id) DO NOTHING
  `;
}
