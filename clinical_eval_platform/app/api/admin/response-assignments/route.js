import { ensureSchema } from "../../../../lib/server/schema";
import { getSql } from "../../../../lib/server/db";

export const runtime = "nodejs";

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function unauthorized() {
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "WWW-Authenticate": 'Basic realm="ClinBench Admin"',
    },
  });
}

function checkAdminAuth(request) {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return { ok: true };

  const username = process.env.ADMIN_USER || "admin";
  const auth = request.headers.get("authorization") || "";
  const [type, encoded] = auth.split(" ");

  if (type === "Basic" && encoded) {
    try {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      const u = idx >= 0 ? decoded.slice(0, idx) : "";
      const p = idx >= 0 ? decoded.slice(idx + 1) : "";
      if (u === username && p === password) return { ok: true };
    } catch {
      // fall through
    }
  }

  return { ok: false, response: unauthorized() };
}

function isUuid(v) {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function toCount(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}

export async function GET(request) {
  const admin = checkAdminAuth(request);
  if (!admin.ok) return admin.response;

  const { searchParams } = new URL(request.url);
  const benchmarkId = String(searchParams.get("benchmarkId") || "").trim();
  if (!benchmarkId) return json(400, { error: "benchmarkId is required" });

  try {
    await ensureSchema();
    const sql = getSql();

    const raters = await sql`
      SELECT id::text AS id, name
      FROM raters
      ORDER BY name ASC
    `;

    const slots = await sql`
      SELECT
        s.question_id,
        s.model_key,
        s.slot::int AS slot,
        s.rater_id::text AS rater_id,
        r.name AS rater_name,
        (e.rater_id IS NOT NULL) AS has_eval,
        COALESCE(e.is_complete, false) AS is_complete
      FROM response_review_slots s
      LEFT JOIN raters r ON r.id = s.rater_id
      LEFT JOIN evaluations e
        ON e.rater_id = s.rater_id
        AND e.benchmark_id = s.benchmark_id
        AND e.question_id = s.question_id
        AND e.model_key = s.model_key
      WHERE s.benchmark_id = ${benchmarkId}
      ORDER BY s.question_id ASC, s.model_key ASC, s.slot ASC
    `;

    return json(200, {
      benchmarkId,
      raters: raters.map((r) => ({ id: r.id, name: r.name })),
      slots: slots.map((s) => ({
        questionId: s.question_id,
        modelKey: s.model_key,
        slot: s.slot,
        raterId: s.rater_id || null,
        raterName: s.rater_name || null,
        hasEval: !!s.has_eval,
        isComplete: !!s.is_complete,
      })),
    });
  } catch (err) {
    console.error(err);
    const msg = err?.message || "Failed to load assignments.";
    const isDb = msg.includes("Database not configured");
    return json(isDb ? 503 : 500, { error: isDb ? msg : "Failed to load assignments." });
  }
}

export async function POST(request) {
  const admin = checkAdminAuth(request);
  if (!admin.ok) return admin.response;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const benchmarkId = String(payload?.benchmarkId || "").trim();
  const fromRaterId = String(payload?.fromRaterId || "").trim();
  const toRaterIdRaw = payload?.toRaterId;
  const toRaterId = toRaterIdRaw == null || toRaterIdRaw === "" ? null : String(toRaterIdRaw).trim();
  const count = toCount(payload?.count);

  if (!benchmarkId) return json(400, { error: "benchmarkId is required" });
  if (!isUuid(fromRaterId)) return json(400, { error: "fromRaterId must be a UUID" });
  if (toRaterId && !isUuid(toRaterId)) return json(400, { error: "toRaterId must be a UUID (or null)" });
  if (count === undefined) return json(400, { error: "count must be a positive integer" });

  const moveN = Math.min(count ?? 1, 2000);
  if (toRaterId && toRaterId === fromRaterId) return json(400, { error: "toRaterId must be different from fromRaterId" });

  try {
    await ensureSchema();
    const sql = getSql();

    const result = await sql.begin(async (tx) => {
      const fromOk = await tx`SELECT 1 AS ok FROM raters WHERE id = ${fromRaterId}::uuid LIMIT 1`;
      if (!fromOk.length) return { status: 400, body: { error: "Unknown fromRaterId." } };

      if (toRaterId) {
        const toOk = await tx`SELECT 1 AS ok FROM raters WHERE id = ${toRaterId}::uuid LIMIT 1`;
        if (!toOk.length) return { status: 400, body: { error: "Unknown toRaterId." } };
      }

      const moved = await tx`
        WITH candidates AS (
          SELECT s.question_id, s.model_key, s.slot
          FROM response_review_slots s
          WHERE s.benchmark_id = ${benchmarkId}
            AND s.rater_id = ${fromRaterId}::uuid
            /* Only move "unattempted" items: no evaluation row exists. */
            AND NOT EXISTS (
              SELECT 1
              FROM evaluations e
              WHERE e.rater_id = s.rater_id
                AND e.benchmark_id = s.benchmark_id
                AND e.question_id = s.question_id
                AND e.model_key = s.model_key
            )
            /* If assigning to another rater, enforce the same guardrails as the single-slot PUT. */
            AND (
              ${toRaterId}::uuid IS NULL
              OR (
                NOT EXISTS (
                  SELECT 1
                  FROM evaluations e2
                  WHERE e2.rater_id = ${toRaterId}::uuid
                    AND e2.benchmark_id = s.benchmark_id
                    AND e2.question_id = s.question_id
                    AND e2.model_key = s.model_key
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM response_review_slots s2
                  WHERE s2.benchmark_id = s.benchmark_id
                    AND s2.question_id = s.question_id
                    AND s2.model_key = s.model_key
                    AND s2.rater_id = ${toRaterId}::uuid
                )
              )
            )
          ORDER BY random()
          LIMIT ${moveN}
        ),
        u AS (
          UPDATE response_review_slots s
          SET
            rater_id = ${toRaterId}::uuid,
            assigned_at = CASE WHEN ${toRaterId}::uuid IS NULL THEN NULL ELSE now() END,
            last_activity_at = CASE WHEN ${toRaterId}::uuid IS NULL THEN NULL ELSE now() END,
            updated_at = now()
          FROM candidates c
          WHERE s.benchmark_id = ${benchmarkId}
            AND s.question_id = c.question_id
            AND s.model_key = c.model_key
            AND s.slot = c.slot
            AND s.rater_id = ${fromRaterId}::uuid
            /* Re-check "unattempted" under race. */
            AND NOT EXISTS (
              SELECT 1
              FROM evaluations e
              WHERE e.rater_id = s.rater_id
                AND e.benchmark_id = s.benchmark_id
                AND e.question_id = s.question_id
                AND e.model_key = s.model_key
            )
          RETURNING 1
        )
        SELECT COUNT(*)::int AS n FROM u
      `;

      return { status: 200, body: { ok: true, moved: moved?.[0]?.n ?? 0 } };
    });

    return json(result.status, result.body);
  } catch (err) {
    console.error(err);
    const msg = err?.message || "Failed to bulk move assignments.";
    const isDb = msg.includes("Database not configured");
    return json(isDb ? 503 : 500, { error: isDb ? msg : "Failed to bulk move assignments." });
  }
}

export async function PUT(request) {
  const admin = checkAdminAuth(request);
  if (!admin.ok) return admin.response;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const benchmarkId = String(payload?.benchmarkId || "").trim();
  const questionId = String(payload?.questionId || "").trim();
  const modelKey = String(payload?.modelKey || "").trim();
  const slot = payload?.slot;
  const raterIdRaw = payload?.raterId;
  const raterId = raterIdRaw == null || raterIdRaw === "" ? null : String(raterIdRaw).trim();

  if (!benchmarkId) return json(400, { error: "benchmarkId is required" });
  if (!questionId) return json(400, { error: "questionId is required" });
  if (!modelKey) return json(400, { error: "modelKey is required" });
  if (!Number.isInteger(slot) || slot < 0 || slot > 2) return json(400, { error: "slot must be an integer in [0,2]" });
  if (raterId && !isUuid(raterId)) return json(400, { error: "raterId must be a UUID (or null)" });

  try {
    await ensureSchema();
    const sql = getSql();

    const result = await sql.begin(async (tx) => {
      const existing = await tx`
        SELECT rater_id::text AS rater_id
        FROM response_review_slots
        WHERE benchmark_id = ${benchmarkId}
          AND question_id = ${questionId}
          AND model_key = ${modelKey}
          AND slot = ${slot}
        FOR UPDATE
      `;
      if (!existing.length) return { status: 404, body: { error: "Assignment slot not found." } };

      if (!raterId) {
        await tx`
          UPDATE response_review_slots
          SET
            rater_id = NULL,
            assigned_at = NULL,
            last_activity_at = NULL,
            updated_at = now()
          WHERE benchmark_id = ${benchmarkId}
            AND question_id = ${questionId}
            AND model_key = ${modelKey}
            AND slot = ${slot}
        `;
        return { status: 200, body: { ok: true, raterId: null } };
      }

      const rater = await tx`SELECT 1 AS ok FROM raters WHERE id = ${raterId}::uuid LIMIT 1`;
      if (!rater.length) return { status: 400, body: { error: "Unknown raterId." } };

      // Guardrail: the same reviewer cannot review the same model response multiple times.
      const alreadyReviewed = await tx`
        SELECT 1 AS ok
        FROM evaluations
        WHERE rater_id = ${raterId}::uuid
          AND benchmark_id = ${benchmarkId}
          AND question_id = ${questionId}
          AND model_key = ${modelKey}
        LIMIT 1
      `;
      if (alreadyReviewed.length) {
        return { status: 409, body: { error: "That rater has already reviewed this model response." } };
      }

      // Guardrail: prevent assigning the same item to the same rater in any slot.
      const alreadyAssigned = await tx`
        SELECT 1 AS ok
        FROM response_review_slots
        WHERE benchmark_id = ${benchmarkId}
          AND question_id = ${questionId}
          AND model_key = ${modelKey}
          AND rater_id = ${raterId}::uuid
        LIMIT 1
      `;
      if (alreadyAssigned.length) {
        return { status: 409, body: { error: "That rater is already assigned this model response." } };
      }

      await tx`
        UPDATE response_review_slots
        SET
          rater_id = ${raterId}::uuid,
          assigned_at = now(),
          last_activity_at = now(),
          updated_at = now()
        WHERE benchmark_id = ${benchmarkId}
          AND question_id = ${questionId}
          AND model_key = ${modelKey}
          AND slot = ${slot}
      `;

      return { status: 200, body: { ok: true, raterId } };
    });

    return json(result.status, result.body);
  } catch (err) {
    console.error(err);
    const msg = err?.message || "Failed to update assignment.";
    const isDb = msg.includes("Database not configured");
    return json(isDb ? 503 : 500, { error: isDb ? msg : "Failed to update assignment." });
  }
}

