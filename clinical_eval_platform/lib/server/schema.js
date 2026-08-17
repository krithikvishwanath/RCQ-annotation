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
      slot smallint NOT NULL,
      rater_id uuid REFERENCES raters(id) ON DELETE SET NULL,
      assigned_at timestamptz,
      last_activity_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (benchmark_id, question_id, slot),
      CONSTRAINT question_review_slots_slot_bounds CHECK (slot >= 0 AND slot < 3)
    )
  `;

  // Existing studies used the automatically named `slot < 2` constraint.
  // Replace it exactly once before inserting the third review slots. The new
  // name makes subsequent cold starts read-only with respect to this migration.
  await sql`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'question_review_slots'::regclass
          AND conname = 'question_review_slots_slot_check'
      ) THEN
        ALTER TABLE question_review_slots
        DROP CONSTRAINT IF EXISTS question_review_slots_slot_check;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'question_review_slots'::regclass
          AND conname = 'question_review_slots_slot_bounds'
      ) THEN
        BEGIN
          ALTER TABLE question_review_slots
          ADD CONSTRAINT question_review_slots_slot_bounds
          CHECK (slot >= 0 AND slot < 3);
        EXCEPTION WHEN duplicate_object THEN
          NULL;
        END;
      END IF;
    END
    $$
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
    CREATE TABLE IF NOT EXISTS rater_dataset_state (
      rater_id uuid NOT NULL REFERENCES raters(id) ON DELETE CASCADE,
      dataset_id text NOT NULL,
      initial_batch_claimed_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (rater_id, dataset_id)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS admin_assignment_events (
      id bigserial PRIMARY KEY,
      dataset_id text NOT NULL,
      question_id text NOT NULL,
      slot smallint NOT NULL,
      action text NOT NULL CHECK (action IN ('release', 'move')),
      source_rater_id uuid REFERENCES raters(id) ON DELETE SET NULL,
      target_rater_id uuid REFERENCES raters(id) ON DELETE SET NULL,
      deleted_annotation boolean NOT NULL DEFAULT false,
      actor text NOT NULL DEFAULT 'admin',
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS admin_assignment_events_dataset_idx
    ON admin_assignment_events (dataset_id, created_at DESC)
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
    INSERT INTO rater_dataset_state (rater_id, dataset_id, initial_batch_claimed_at)
    SELECT
      rater_id,
      benchmark_id,
      MIN(COALESCE(assigned_at, created_at))
    FROM question_review_slots
    WHERE benchmark_id = ${datasetId}
      AND rater_id IS NOT NULL
    GROUP BY rater_id, benchmark_id
    ON CONFLICT (rater_id, dataset_id) DO NOTHING
  `;

  await sql`
    INSERT INTO rater_dataset_state (rater_id, dataset_id, initial_batch_claimed_at)
    SELECT rater_id, dataset_id, MIN(created_at)
    FROM annotations
    WHERE dataset_id = ${datasetId}
    GROUP BY rater_id, dataset_id
    ON CONFLICT (rater_id, dataset_id) DO NOTHING
  `;

  await sql`
    INSERT INTO benchmark_state (benchmark_id, run_version, updated_at)
    VALUES (${datasetId}, 1, now())
    ON CONFLICT (benchmark_id) DO NOTHING
  `;
}
