import { ensureSchema } from "../../../lib/server/schema";
import { getSql } from "../../../lib/server/db";

export const runtime = "nodejs";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isUuid(v) {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function toLikert(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 4) return undefined;
  return n;
}

function toBoolOrNull(v) {
  if (v === true || v === false) return v;
  if (v == null || v === "") return null;
  return undefined;
}

function isComplete(ev) {
  return (
    ev.accuracy != null &&
    ev.completeness != null &&
    ev.safety != null &&
    ev.communication != null &&
    ev.harmful != null &&
    ev.hallucinated != null
  );
}

function checkAccessCode(request, payload) {
  const required = process.env.EVAL_ACCESS_CODE;
  if (!required) return { ok: true };

  const fromHeader = request.headers.get("x-access-code");
  const fromBody = payload?.accessCode;
  if (String(fromHeader || fromBody || "") !== String(required)) {
    return { ok: false, status: 401, error: "Invalid access code." };
  }
  return { ok: true };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("sessionId");
  const benchmarkId = searchParams.get("benchmarkId");

  if (!isUuid(sessionId || "")) return json(400, { error: "Invalid sessionId" });
  if (!benchmarkId) return json(400, { error: "benchmarkId is required" });

  const access = checkAccessCode(request, null);
  if (!access.ok) return json(access.status, { error: access.error });

  try {
    await ensureSchema();
    const sql = getSql();

    const rater = await sql`
      SELECT 1 AS ok
      FROM raters
      WHERE id = ${sessionId}::uuid
      LIMIT 1
    `;
    if (!rater.length) {
      return json(401, { error: "Session not found. Please restart from the home page." });
    }

    await sql`
      INSERT INTO benchmark_state (benchmark_id, run_version, updated_at)
      VALUES (${benchmarkId}, 1, now())
      ON CONFLICT (benchmark_id) DO NOTHING
    `;
    const state = await sql`
      SELECT run_version::int AS run_version
      FROM benchmark_state
      WHERE benchmark_id = ${benchmarkId}
      LIMIT 1
    `;
    const runVersion = state?.[0]?.run_version ?? 1;

    const rows = await sql`
      SELECT
        question_id,
        model_key,
        model_order,
        accuracy,
        completeness,
        safety,
        communication,
        harmful,
        hallucinated,
        notes,
        is_complete
      FROM evaluations
      WHERE rater_id = ${sessionId}::uuid
        AND benchmark_id = ${benchmarkId}
    `;
    return json(200, { runVersion, evaluations: rows });
  } catch (err) {
    console.error(err);
    const msg = err?.message || "Failed to load evaluations.";
    const isDb = msg.includes("Database not configured");
    return json(isDb ? 503 : 500, { error: isDb ? msg : "Failed to load evaluations." });
  }
}

export async function PUT(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const access = checkAccessCode(request, payload);
  if (!access.ok) return json(access.status, { error: access.error });

  const sessionId = payload?.sessionId;
  const benchmarkId = payload?.benchmarkId;
  const questionId = payload?.questionId;
  const modelKey = payload?.modelKey;
  const modelOrder = payload?.modelOrder;

  if (!isUuid(sessionId || "")) return json(400, { error: "Invalid sessionId" });
  if (!benchmarkId) return json(400, { error: "benchmarkId is required" });
  if (!questionId) return json(400, { error: "questionId is required" });
  if (!modelKey) return json(400, { error: "modelKey is required" });
  if (!Number.isInteger(modelOrder)) return json(400, { error: "modelOrder must be an integer" });

  const ev = {
    accuracy: toLikert(payload?.accuracy),
    completeness: toLikert(payload?.completeness),
    safety: toLikert(payload?.safety),
    communication: toLikert(payload?.communication),
    harmful: toBoolOrNull(payload?.harmful),
    hallucinated: toBoolOrNull(payload?.hallucinated),
    notes: typeof payload?.notes === "string" ? payload.notes : "",
  };

  for (const [k, v] of Object.entries(ev)) {
    if (v === undefined) return json(400, { error: `Invalid value for ${k}` });
  }

  if (ev.notes.length > 4000) return json(400, { error: "Notes too long (max 4000 chars)" });

  const complete = isComplete(ev);

  try {
    await ensureSchema();
    const sql = getSql();

    const rater = await sql`
      SELECT 1 AS ok
      FROM raters
      WHERE id = ${sessionId}::uuid
      LIMIT 1
    `;
    if (!rater.length) {
      return json(401, { error: "Session not found. Please restart from the home page." });
    }

    const wrote = await sql`
      WITH has_slots AS (
        SELECT 1 AS ok
        FROM response_review_slots
        WHERE benchmark_id = ${benchmarkId}
        LIMIT 1
      ),
      allowed AS (
        SELECT 1 AS ok
        FROM response_review_slots
        WHERE benchmark_id = ${benchmarkId}
          AND question_id = ${questionId}
          AND model_key = ${modelKey}
          AND rater_id = ${sessionId}::uuid
        LIMIT 1
      ),
      gate AS (
        SELECT 1 AS ok
        WHERE EXISTS (SELECT 1 FROM allowed)
           OR NOT EXISTS (SELECT 1 FROM has_slots)
      )
      INSERT INTO evaluations (
        rater_id,
        benchmark_id,
        question_id,
        model_key,
        model_order,
        accuracy,
        completeness,
        safety,
        communication,
        harmful,
        hallucinated,
        notes,
        is_complete,
        updated_at
      )
      SELECT
        ${sessionId}::uuid,
        ${benchmarkId},
        ${questionId},
        ${modelKey},
        ${modelOrder},
        ${ev.accuracy},
        ${ev.completeness},
        ${ev.safety},
        ${ev.communication},
        ${ev.harmful},
        ${ev.hallucinated},
        ${ev.notes},
        ${complete},
        now()
      FROM gate
      ON CONFLICT (rater_id, benchmark_id, question_id, model_key)
      DO UPDATE SET
        model_order = EXCLUDED.model_order,
        accuracy = EXCLUDED.accuracy,
        completeness = EXCLUDED.completeness,
        safety = EXCLUDED.safety,
        communication = EXCLUDED.communication,
        harmful = EXCLUDED.harmful,
        hallucinated = EXCLUDED.hallucinated,
        notes = EXCLUDED.notes,
        is_complete = EXCLUDED.is_complete,
        updated_at = now()
      RETURNING 1
    `;

    if (!wrote.length) {
      return json(403, { error: "This question is not assigned to this rater." });
    }

    return json(200, { ok: true, isComplete: complete });
  } catch (err) {
    console.error(err);
    const msg = err?.message || "Failed to save evaluation.";
    const isDb = msg.includes("Database not configured");
    return json(isDb ? 503 : 500, { error: isDb ? msg : "Failed to save evaluation." });
  }
}

