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

async function readPayload(request) {
  const ct = String(request.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("application/json")) {
    try {
      return await request.json();
    } catch {
      return {};
    }
  }
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    try {
      const fd = await request.formData();
      const obj = {};
      for (const [k, v] of fd.entries()) obj[k] = v;
      return obj;
    } catch {
      return {};
    }
  }
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function isTruthy(v) {
  return v === true || v === 1 || v === "1" || String(v || "").toLowerCase() === "true";
}

export async function POST(request) {
  const admin = checkAdminAuth(request);
  if (!admin.ok) return admin.response;

  const { searchParams } = new URL(request.url);
  const payload = await readPayload(request);

  const benchmarkId = String(payload?.benchmarkId || searchParams.get("benchmarkId") || "").trim();
  const wantsAll = isTruthy(payload?.all ?? searchParams.get("all"));
  const confirm = String(payload?.confirm || searchParams.get("confirm") || "").trim();

  if (!wantsAll && !benchmarkId) {
    return json(400, { error: "benchmarkId is required (or set all=true)." });
  }

  if (wantsAll) {
    if (confirm !== "NUKE ALL") {
      return json(400, { error: 'Confirmation required. Type exactly "NUKE ALL".' });
    }
  } else {
    const ok =
      confirm === "NUKE" ||
      confirm.toLowerCase() === `nuke ${benchmarkId.toLowerCase()}`;
    if (!ok) {
      return json(400, { error: `Confirmation required. Type "NUKE" (or "NUKE ${benchmarkId}").` });
    }
  }

  try {
    await ensureSchema();
    const sql = getSql();

    const targetIds = wantsAll
      ? (await sql`
          SELECT benchmark_id FROM benchmark_state
          UNION
          SELECT DISTINCT benchmark_id FROM evaluations
          UNION
          SELECT DISTINCT benchmark_id FROM question_review_slots
          UNION
          SELECT DISTINCT benchmark_id FROM response_review_slots
        `)
          .map((r) => r.benchmark_id)
          .filter(Boolean)
      : [benchmarkId];

    if (!targetIds.length) {
      return json(200, { ok: true, benchmarkIds: [], deletedEvaluations: 0, clearedAssignments: 0, runVersions: [] });
    }

    const ids = Array.from(new Set(targetIds.map((x) => String(x).trim()).filter(Boolean)));

    const result = await sql.begin(async (tx) => {
      await tx`
        INSERT INTO benchmark_state (benchmark_id, run_version, updated_at)
        SELECT b.benchmark_id, 1, now()
        FROM unnest(${tx.array(ids)}::text[]) AS b(benchmark_id)
        ON CONFLICT (benchmark_id) DO NOTHING
      `;

      const del = await tx`
        WITH d AS (
          DELETE FROM evaluations
          WHERE benchmark_id = ANY(${tx.array(ids)}::text[])
          RETURNING 1
        )
        SELECT COUNT(*)::int AS n FROM d
      `;

      const cleared = await tx`
        WITH u AS (
          UPDATE question_review_slots
          SET
            rater_id = NULL,
            assigned_at = NULL,
            last_activity_at = NULL,
            updated_at = now()
          WHERE benchmark_id = ANY(${tx.array(ids)}::text[])
            AND rater_id IS NOT NULL
          RETURNING 1
        ),
        u2 AS (
          UPDATE response_review_slots
          SET
            rater_id = NULL,
            assigned_at = NULL,
            last_activity_at = NULL,
            updated_at = now()
          WHERE benchmark_id = ANY(${tx.array(ids)}::text[])
            AND rater_id IS NOT NULL
          RETURNING 1
        )
        SELECT (SELECT COUNT(*)::int FROM u) + (SELECT COUNT(*)::int FROM u2) AS n
      `;

      const versions = await tx`
        UPDATE benchmark_state
        SET
          run_version = run_version + 1,
          reset_at = now(),
          updated_at = now()
        WHERE benchmark_id = ANY(${tx.array(ids)}::text[])
        RETURNING benchmark_id, run_version::int AS run_version
      `;

      return {
        deletedEvaluations: del?.[0]?.n ?? 0,
        clearedAssignments: cleared?.[0]?.n ?? 0,
        runVersions: versions,
      };
    });

    return json(200, { ok: true, benchmarkIds: ids, ...result });
  } catch (err) {
    console.error(err);
    const msg = err?.message || "Failed to reset.";
    const isDb = msg.includes("Database not configured");
    return json(isDb ? 503 : 500, { error: isDb ? msg : "Failed to reset." });
  }
}

