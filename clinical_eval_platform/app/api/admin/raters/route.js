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

export async function GET(request) {
  const admin = checkAdminAuth(request);
  if (!admin.ok) return admin.response;

  try {
    await ensureSchema();
    const sql = getSql();

    const rows = await sql`
      SELECT
        r.id::text AS id,
        r.name,
        r.created_at,
        COALESCE(ev.total, 0)::int AS evaluations_total,
        COALESCE(ev.complete, 0)::int AS evaluations_complete,
        COALESCE(asg.assigned, 0)::int AS assigned_responses
      FROM raters r
      LEFT JOIN (
        SELECT
          rater_id,
          COUNT(*)::int AS total,
          SUM(CASE WHEN is_complete THEN 1 ELSE 0 END)::int AS complete
        FROM evaluations
        GROUP BY rater_id
      ) ev ON ev.rater_id = r.id
      LEFT JOIN (
        SELECT
          rater_id,
          COUNT(*)::int AS assigned
        FROM response_review_slots
        WHERE rater_id IS NOT NULL
        GROUP BY rater_id
      ) asg ON asg.rater_id = r.id
      ORDER BY r.created_at DESC
    `;

    return json(200, {
      raters: rows.map((r) => ({
        id: r.id,
        name: r.name,
        createdAt: r.created_at,
        assignedResponses: r.assigned_responses,
        evaluationsTotal: r.evaluations_total,
        evaluationsComplete: r.evaluations_complete,
      })),
    });
  } catch (err) {
    console.error(err);
    const msg = err?.message || "Failed to load raters.";
    const isDb = msg.includes("Database not configured");
    return json(isDb ? 503 : 500, { error: isDb ? msg : "Failed to load raters." });
  }
}

export async function DELETE(request) {
  const admin = checkAdminAuth(request);
  if (!admin.ok) return admin.response;

  let payload;
  try {
    payload = await request.json();
  } catch {
    return json(400, { error: "Invalid JSON" });
  }

  const raterId = String(payload?.raterId || "").trim();
  if (!isUuid(raterId)) return json(400, { error: "raterId must be a UUID" });

  try {
    await ensureSchema();
    const sql = getSql();

    const result = await sql.begin(async (tx) => {
      const clearedResp = await tx`
        WITH u AS (
          UPDATE response_review_slots
          SET
            rater_id = NULL,
            assigned_at = NULL,
            last_activity_at = NULL,
            updated_at = now()
          WHERE rater_id = ${raterId}::uuid
          RETURNING 1
        )
        SELECT COUNT(*)::int AS n FROM u
      `;

      const clearedQ = await tx`
        WITH u AS (
          UPDATE question_review_slots
          SET
            rater_id = NULL,
            assigned_at = NULL,
            last_activity_at = NULL,
            updated_at = now()
          WHERE rater_id = ${raterId}::uuid
          RETURNING 1
        )
        SELECT COUNT(*)::int AS n FROM u
      `;

      const deletedEvals = await tx`
        WITH d AS (
          DELETE FROM evaluations
          WHERE rater_id = ${raterId}::uuid
          RETURNING 1
        )
        SELECT COUNT(*)::int AS n FROM d
      `;

      const deletedRater = await tx`
        WITH d AS (
          DELETE FROM raters
          WHERE id = ${raterId}::uuid
          RETURNING 1
        )
        SELECT COUNT(*)::int AS n FROM d
      `;

      return {
        deletedRaters: deletedRater?.[0]?.n ?? 0,
        deletedEvaluations: deletedEvals?.[0]?.n ?? 0,
        clearedResponseAssignments: clearedResp?.[0]?.n ?? 0,
        clearedQuestionAssignments: clearedQ?.[0]?.n ?? 0,
      };
    });

    if (!result.deletedRaters) return json(404, { error: "Rater not found." });

    return json(200, { ok: true, ...result });
  } catch (err) {
    console.error(err);
    const msg = err?.message || "Failed to delete rater.";
    const isDb = msg.includes("Database not configured");
    return json(isDb ? 503 : 500, { error: isDb ? msg : "Failed to delete rater." });
  }
}

