import { getSql } from "./db";
import modelMap from "../../data/model_map.json";
import benchmarkQuestions from "../../data/benchmark_questions.json";

let _schemaPromise;

export async function ensureSchema() {
  if (_schemaPromise) return _schemaPromise;

  _schemaPromise = (async () => {
    const sql = getSql();

    await sql`
      CREATE TABLE IF NOT EXISTS raters (
        id uuid PRIMARY KEY,
        name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS evaluations (
        rater_id uuid NOT NULL REFERENCES raters(id) ON DELETE CASCADE,
        benchmark_id text NOT NULL,
        question_id text NOT NULL,
        model_key text NOT NULL,
        model_order int NOT NULL,

        accuracy smallint,
        completeness smallint,
        safety smallint,
        communication smallint,
        harmful boolean,
        hallucinated boolean,
        notes text,
        is_complete boolean NOT NULL DEFAULT false,

        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),

        PRIMARY KEY (rater_id, benchmark_id, question_id, model_key)
      )
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS evaluations_benchmark_idx
      ON evaluations (benchmark_id)
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS benchmark_models (
        benchmark_id text NOT NULL,
        model_id text NOT NULL,
        model_name text NOT NULL,
        model_order int NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (benchmark_id, model_id)
      )
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

    // Assignments for response-level sampling: each (question_id, model_key) can be assigned
    // to up to 3 raters (slots 0..2). This matches "independent evaluations" per model response.
    await sql`
      CREATE TABLE IF NOT EXISTS response_review_slots (
        benchmark_id text NOT NULL,
        question_id text NOT NULL,
        model_key text NOT NULL,
        slot smallint NOT NULL CHECK (slot >= 0 AND slot < 3),
        rater_id uuid REFERENCES raters(id) ON DELETE SET NULL,
        assigned_at timestamptz,
        last_activity_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (benchmark_id, question_id, model_key, slot)
      )
    `;

    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS response_review_slots_unique_rater
      ON response_review_slots (benchmark_id, question_id, model_key, rater_id)
      WHERE rater_id IS NOT NULL
    `;

    await sql`
      CREATE INDEX IF NOT EXISTS response_review_slots_rater_idx
      ON response_review_slots (rater_id, benchmark_id)
    `;

    await sql`
      CREATE TABLE IF NOT EXISTS question_review_slots (
        benchmark_id text NOT NULL,
        question_id text NOT NULL,
        slot smallint NOT NULL CHECK (slot >= 0 AND slot < 3),
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

    // Seed current benchmark's model mapping (used for admin export + analysis).
    if (modelMap?.benchmarkId && Array.isArray(modelMap.models)) {
      for (let i = 0; i < modelMap.models.length; i++) {
        const m = modelMap.models[i];
        const modelId = String(m?.id || "").trim();
        const modelName = String(m?.name || "").trim();
        if (!modelId || !modelName) continue;
        await sql`
          INSERT INTO benchmark_models (
            benchmark_id,
            model_id,
            model_name,
            model_order,
            updated_at
          ) VALUES (
            ${modelMap.benchmarkId},
            ${modelId},
            ${modelName},
            ${i},
            now()
          )
          ON CONFLICT (benchmark_id, model_id)
          DO UPDATE SET
            model_name = EXCLUDED.model_name,
            model_order = EXCLUDED.model_order,
            updated_at = now()
        `;
      }
    }

    // Seed response slots for sampling: each model response can be assigned to up to 3 raters.
    if (
      benchmarkQuestions?.benchmarkId &&
      Array.isArray(benchmarkQuestions.questions) &&
      benchmarkQuestions.questions.length &&
      modelMap?.benchmarkId &&
      Array.isArray(modelMap.models) &&
      modelMap.models.length &&
      String(modelMap.benchmarkId) === String(benchmarkQuestions.benchmarkId)
    ) {
      const qids = benchmarkQuestions.questions
        .map((q) => String(q || "").trim())
        .filter(Boolean);
      const modelKeys = modelMap.models
        .map((m) => String(m?.id || "").trim())
        .filter(Boolean);

      if (qids.length && modelKeys.length) {
        await sql`
          INSERT INTO response_review_slots (benchmark_id, question_id, model_key, slot)
          SELECT
            ${benchmarkQuestions.benchmarkId},
            qid.question_id,
            mid.model_key,
            gs.slot
          FROM unnest(${sql.array(qids)}::text[]) AS qid(question_id)
          CROSS JOIN unnest(${sql.array(modelKeys)}::text[]) AS mid(model_key)
          CROSS JOIN generate_series(0, 2) AS gs(slot)
          ON CONFLICT (benchmark_id, question_id, model_key, slot)
          DO NOTHING
        `;
      }
    }

    // Seed question slots for sampling: each question can be assigned to up to 3 raters.
    if (
      benchmarkQuestions?.benchmarkId &&
      Array.isArray(benchmarkQuestions.questions) &&
      benchmarkQuestions.questions.length
    ) {
      const qids = benchmarkQuestions.questions
        .map((q) => String(q || "").trim())
        .filter(Boolean);

      if (qids.length) {
        await sql`
          INSERT INTO question_review_slots (benchmark_id, question_id, slot)
          SELECT ${benchmarkQuestions.benchmarkId}, qid.question_id, gs.slot
          FROM unnest(${sql.array(qids)}::text[]) AS qid(question_id)
          CROSS JOIN generate_series(0, 2) AS gs(slot)
          ON CONFLICT (benchmark_id, question_id, slot)
          DO NOTHING
        `;
      }
    }

    // Ensure benchmark state exists (used for "reset/nuke" + local cache invalidation).
    const stateBenchId = String(benchmarkQuestions?.benchmarkId || modelMap?.benchmarkId || "").trim();
    if (stateBenchId) {
      await sql`
        INSERT INTO benchmark_state (benchmark_id, run_version, updated_at)
        VALUES (${stateBenchId}, 1, now())
        ON CONFLICT (benchmark_id) DO NOTHING
      `;
    }
  })();

  return _schemaPromise;
}

