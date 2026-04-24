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
  return (
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
  );
}

function toCount(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < 1) return undefined;
  return n;
}

function defaultAssignmentCount() {
  const n = toCount(process.env.NEXT_PUBLIC_DEFAULT_ASSIGNMENT_COUNT);
  if (n == null || n === undefined) return 150;
  return n;
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

async function getStats(sql, benchmarkId) {
  const rows = await sql`
    SELECT
      /* Unassigned slots/items (standard claiming) */
      (
        SELECT COUNT(*)::int
        FROM response_review_slots s
        WHERE s.benchmark_id = ${benchmarkId}
          AND s.rater_id IS NULL
      ) AS remaining_slots,
      (
        SELECT COUNT(DISTINCT (s.question_id, s.model_key))::int
        FROM response_review_slots s
        WHERE s.benchmark_id = ${benchmarkId}
          AND s.rater_id IS NULL
      ) AS remaining_items,

      /* Fully-assigned items where at least one assigned slot is still unstarted (no evaluation row) */
      (
        SELECT COUNT(*)::int
        FROM response_review_slots s
        WHERE s.benchmark_id = ${benchmarkId}
          AND s.rater_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM evaluations e
            WHERE e.rater_id = s.rater_id
              AND e.benchmark_id = s.benchmark_id
              AND e.question_id = s.question_id
              AND e.model_key = s.model_key
          )
          AND NOT EXISTS (
            SELECT 1
            FROM response_review_slots s0
            WHERE s0.benchmark_id = s.benchmark_id
              AND s0.question_id = s.question_id
              AND s0.model_key = s.model_key
              AND s0.rater_id IS NULL
          )
      ) AS stealable_slots,
      (
        SELECT COUNT(DISTINCT (s.question_id, s.model_key))::int
        FROM response_review_slots s
        WHERE s.benchmark_id = ${benchmarkId}
          AND s.rater_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM evaluations e
            WHERE e.rater_id = s.rater_id
              AND e.benchmark_id = s.benchmark_id
              AND e.question_id = s.question_id
              AND e.model_key = s.model_key
          )
          AND NOT EXISTS (
            SELECT 1
            FROM response_review_slots s0
            WHERE s0.benchmark_id = s.benchmark_id
              AND s0.question_id = s.question_id
              AND s0.model_key = s.model_key
              AND s0.rater_id IS NULL
          )
      ) AS stealable_items
  `;
  return {
    remainingSlots: rows?.[0]?.remaining_slots ?? 0,
    remainingItems: rows?.[0]?.remaining_items ?? 0,
    stealableSlots: rows?.[0]?.stealable_slots ?? 0,
    stealableItems: rows?.[0]?.stealable_items ?? 0,
  };
}

async function getRunVersion(sql, benchmarkId) {
  await sql`
    INSERT INTO benchmark_state (benchmark_id, run_version, updated_at)
    VALUES (${benchmarkId}, 1, now())
    ON CONFLICT (benchmark_id) DO NOTHING
  `;
  const rows = await sql`
    SELECT run_version::int AS run_version
    FROM benchmark_state
    WHERE benchmark_id = ${benchmarkId}
    LIMIT 1
  `;
  return rows?.[0]?.run_version ?? 1;
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

    const assigned = await sql`
      SELECT question_id, model_key
      FROM response_review_slots
      WHERE rater_id = ${sessionId}::uuid
        AND benchmark_id = ${benchmarkId}
      ORDER BY question_id ASC, model_key ASC
    `;

    const runVersion = await getRunVersion(sql, benchmarkId);
    const stats = await getStats(sql, benchmarkId);

    return json(200, {
      runVersion,
      items: assigned.map((r) => ({ questionId: r.question_id, modelKey: r.model_key })),
      ...stats,
    });
  } catch (err) {
    console.error(err);
    const msg = err?.message || "Failed to load assignments.";
    const isDb = msg.includes("Database not configured");
    return json(isDb ? 503 : 500, { error: isDb ? msg : "Failed to load assignments." });
  }
}

export async function POST(request) {
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
  const count = toCount(payload?.count);

  if (!isUuid(sessionId || "")) return json(400, { error: "Invalid sessionId" });
  if (!benchmarkId) return json(400, { error: "benchmarkId is required" });
  if (count === undefined) return json(400, { error: "count must be a positive integer" });

  const claimN = Math.min(count ?? defaultAssignmentCount(), 2000);

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

    const claimed = await sql`
      WITH bench_has_unassigned AS (
        SELECT EXISTS (
          SELECT 1
          FROM response_review_slots s
          WHERE s.benchmark_id = ${benchmarkId}
            AND s.rater_id IS NULL
          LIMIT 1
        ) AS has_unassigned
      ),
      candidate_slots AS (
        /* Prefer truly-unassigned slots first (standard flow). */
        SELECT
          s.benchmark_id,
          s.question_id,
          s.model_key,
          s.slot,
          0::int AS prio
        FROM response_review_slots s
        WHERE s.benchmark_id = ${benchmarkId}
          AND s.rater_id IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM response_review_slots s2
            WHERE s2.benchmark_id = s.benchmark_id
              AND s2.question_id = s.question_id
              AND s2.model_key = s.model_key
              AND s2.rater_id = ${sessionId}::uuid
          )
          AND NOT EXISTS (
            SELECT 1
            FROM evaluations e
            WHERE e.rater_id = ${sessionId}::uuid
              AND e.benchmark_id = s.benchmark_id
              AND e.question_id = s.question_id
              AND e.model_key = s.model_key
          )

        UNION ALL

        /*
          Only steal from others when the benchmark has *no* unassigned slots left.
          (If any unassigned slots exist, never take work away from other reviewers.)
        */
        SELECT
          s.benchmark_id,
          s.question_id,
          s.model_key,
          s.slot,
          1::int AS prio
        FROM response_review_slots s
        CROSS JOIN bench_has_unassigned bhu
        WHERE s.benchmark_id = ${benchmarkId}
          AND NOT bhu.has_unassigned
          AND s.rater_id IS NOT NULL
          AND s.rater_id <> ${sessionId}::uuid
          /* Only steal from items that have no unassigned slots (fully assigned). */
          AND NOT EXISTS (
            SELECT 1
            FROM response_review_slots s0
            WHERE s0.benchmark_id = s.benchmark_id
              AND s0.question_id = s.question_id
              AND s0.model_key = s.model_key
              AND s0.rater_id IS NULL
          )
          /* Only steal if the current assignee hasn't started (no evaluation row). */
          AND NOT EXISTS (
            SELECT 1
            FROM evaluations e_assigned
            WHERE e_assigned.rater_id = s.rater_id
              AND e_assigned.benchmark_id = s.benchmark_id
              AND e_assigned.question_id = s.question_id
              AND e_assigned.model_key = s.model_key
          )
          /* And never assign duplicates to the requester. */
          AND NOT EXISTS (
            SELECT 1
            FROM response_review_slots s2
            WHERE s2.benchmark_id = s.benchmark_id
              AND s2.question_id = s.question_id
              AND s2.model_key = s.model_key
              AND s2.rater_id = ${sessionId}::uuid
          )
          AND NOT EXISTS (
            SELECT 1
            FROM evaluations e
            WHERE e.rater_id = ${sessionId}::uuid
              AND e.benchmark_id = s.benchmark_id
              AND e.question_id = s.question_id
              AND e.model_key = s.model_key
          )
      ),
      picked AS (
        /*
          Pick one slot per (question, model), then randomize item selection
          before LIMIT so new raters do not always get the same leading IDs.
        */
        SELECT benchmark_id, question_id, model_key, slot, prio
        FROM (
          SELECT DISTINCT ON (question_id, model_key)
            benchmark_id, question_id, model_key, slot, prio
          FROM candidate_slots
          ORDER BY question_id, model_key, prio ASC, random()
        ) one_per_item
        ORDER BY prio ASC, random()
        LIMIT ${claimN}
      )
      UPDATE response_review_slots s
      SET
        rater_id = ${sessionId}::uuid,
        assigned_at = now(),
        last_activity_at = now(),
        updated_at = now()
      FROM picked p
      WHERE s.benchmark_id = p.benchmark_id
        AND s.question_id = p.question_id
        AND s.model_key = p.model_key
        AND s.slot = p.slot
        AND s.rater_id IS DISTINCT FROM ${sessionId}::uuid
        /* Never "steal" in a race when we picked an unassigned slot. */
        AND (p.prio <> 0 OR s.rater_id IS NULL)
        /* Re-check guardrails under lock/race: */
        AND NOT EXISTS (
          SELECT 1
          FROM response_review_slots s2
          WHERE s2.benchmark_id = s.benchmark_id
            AND s2.question_id = s.question_id
            AND s2.model_key = s.model_key
            AND s2.rater_id = ${sessionId}::uuid
        )
        AND NOT EXISTS (
          SELECT 1
          FROM evaluations e
          WHERE e.rater_id = ${sessionId}::uuid
            AND e.benchmark_id = s.benchmark_id
            AND e.question_id = s.question_id
            AND e.model_key = s.model_key
        )
        /* If we are stealing, only take it if the current assignee is still unstarted. */
        AND (
          s.rater_id IS NULL OR NOT EXISTS (
            SELECT 1
            FROM evaluations e_assigned
            WHERE e_assigned.rater_id = s.rater_id
              AND e_assigned.benchmark_id = s.benchmark_id
              AND e_assigned.question_id = s.question_id
              AND e_assigned.model_key = s.model_key
          )
        )
      RETURNING s.question_id, s.model_key
    `;

    const assigned = await sql`
      SELECT question_id, model_key
      FROM response_review_slots
      WHERE rater_id = ${sessionId}::uuid
        AND benchmark_id = ${benchmarkId}
      ORDER BY question_id ASC, model_key ASC
    `;

    const runVersion = await getRunVersion(sql, benchmarkId);
    const stats = await getStats(sql, benchmarkId);

    return json(200, {
      runVersion,
      claimed: claimed.map((r) => ({ questionId: r.question_id, modelKey: r.model_key })),
      items: assigned.map((r) => ({ questionId: r.question_id, modelKey: r.model_key })),
      ...stats,
    });
  } catch (err) {
    console.error(err);
    const msg = err?.message || "Failed to claim assignments.";
    const isDb = msg.includes("Database not configured");
    return json(isDb ? 503 : 500, { error: isDb ? msg : "Failed to claim assignments." });
  }
}
