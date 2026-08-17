import { ensureSchema } from "../../../lib/server/schema";
import { getSql } from "../../../lib/server/db";
import { checkAccessCode, isUuid, json, publicError } from "../../../lib/server/request";

export const runtime = "nodejs";

function parseCount(value) {
  if (value == null || value === "") return null;
  const count = typeof value === "number" ? value : Number(value);
  return Number.isInteger(count) && count > 0 ? count : undefined;
}

function defaultAssignmentCount() {
  const count = parseCount(process.env.NEXT_PUBLIC_DEFAULT_ASSIGNMENT_COUNT);
  return count == null || count === undefined ? 40 : Math.min(count, 500);
}

async function getRunVersion(sql, datasetId) {
  await sql`
    INSERT INTO benchmark_state (benchmark_id, run_version, updated_at)
    VALUES (${datasetId}, 1, now())
    ON CONFLICT (benchmark_id) DO NOTHING
  `;
  const rows = await sql`
    SELECT run_version::int AS run_version
    FROM benchmark_state
    WHERE benchmark_id = ${datasetId}
    LIMIT 1
  `;
  return rows?.[0]?.run_version ?? 1;
}

async function getAvailability(sql, datasetId) {
  const rows = await sql`
    SELECT
      COUNT(*) FILTER (WHERE rater_id IS NULL)::int AS remaining_slots,
      COUNT(DISTINCT question_id) FILTER (WHERE rater_id IS NULL)::int AS remaining_queries
    FROM question_review_slots
    WHERE benchmark_id = ${datasetId}
  `;
  return {
    remainingSlots: rows?.[0]?.remaining_slots ?? 0,
    remainingQueries: rows?.[0]?.remaining_queries ?? 0,
  };
}

async function requireRater(sql, sessionId) {
  const rater = await sql`
    SELECT 1 AS ok FROM raters WHERE id = ${sessionId}::uuid LIMIT 1
  `;
  return rater.length > 0;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const sessionId = searchParams.get("sessionId");
  const datasetId = searchParams.get("datasetId");

  if (!isUuid(sessionId || "")) return json(400, { error: "Invalid sessionId." });
  if (!datasetId) return json(400, { error: "datasetId is required." });
  const access = checkAccessCode(request);
  if (!access.ok) return json(access.status, { error: access.error });

  try {
    await ensureSchema();
    const sql = getSql();
    if (!(await requireRater(sql, sessionId))) {
      return json(401, { error: "Session not found. Please sign in again." });
    }

    const assigned = await sql`
      SELECT question_id
      FROM question_review_slots
      WHERE rater_id = ${sessionId}::uuid AND benchmark_id = ${datasetId}
      ORDER BY assigned_at ASC, question_id ASC
    `;

    return json(200, {
      runVersion: await getRunVersion(sql, datasetId),
      questionIds: assigned.map((row) => row.question_id),
      ...(await getAvailability(sql, datasetId)),
    });
  } catch (error) {
    return publicError(error, "Failed to load assignments.");
  }
}

export async function POST(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON." });
  }

  const access = checkAccessCode(request, payload);
  if (!access.ok) return json(access.status, { error: access.error });
  const sessionId = payload?.sessionId;
  const datasetId = payload?.datasetId;
  const count = parseCount(payload?.count);
  if (!isUuid(sessionId || "")) return json(400, { error: "Invalid sessionId." });
  if (!datasetId) return json(400, { error: "datasetId is required." });
  if (count === undefined) return json(400, { error: "count must be a positive integer." });
  const claimCount = Math.min(count ?? defaultAssignmentCount(), 500);

  try {
    await ensureSchema();
    const sql = getSql();
    if (!(await requireRater(sql, sessionId))) {
      return json(401, { error: "Session not found. Please sign in again." });
    }

    const claimed = await sql`
      WITH one_slot_per_query AS (
        SELECT DISTINCT ON (s.question_id)
          s.benchmark_id, s.question_id, s.slot
        FROM question_review_slots s
        WHERE s.benchmark_id = ${datasetId}
          AND s.rater_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM question_review_slots mine
            WHERE mine.benchmark_id = s.benchmark_id
              AND mine.question_id = s.question_id
              AND mine.rater_id = ${sessionId}::uuid
          )
          AND NOT EXISTS (
            SELECT 1 FROM annotations a
            WHERE a.dataset_id = s.benchmark_id
              AND a.question_id = s.question_id
              AND a.rater_id = ${sessionId}::uuid
          )
        ORDER BY s.question_id, s.slot
      ), picked AS (
        SELECT * FROM one_slot_per_query ORDER BY random() LIMIT ${claimCount}
      )
      UPDATE question_review_slots slots
      SET rater_id = ${sessionId}::uuid,
          assigned_at = now(),
          last_activity_at = now(),
          updated_at = now()
      FROM picked
      WHERE slots.benchmark_id = picked.benchmark_id
        AND slots.question_id = picked.question_id
        AND slots.slot = picked.slot
        AND slots.rater_id IS NULL
      RETURNING slots.question_id
    `;

    const assigned = await sql`
      SELECT question_id
      FROM question_review_slots
      WHERE rater_id = ${sessionId}::uuid AND benchmark_id = ${datasetId}
      ORDER BY assigned_at ASC, question_id ASC
    `;

    return json(200, {
      runVersion: await getRunVersion(sql, datasetId),
      claimedQuestionIds: claimed.map((row) => row.question_id),
      questionIds: assigned.map((row) => row.question_id),
      ...(await getAvailability(sql, datasetId)),
    });
  } catch (error) {
    return publicError(error, "Failed to claim assignments.");
  }
}
