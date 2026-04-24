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

export async function POST(request) {
  const admin = checkAdminAuth(request);
  if (!admin.ok) return admin.response;

  const { searchParams } = new URL(request.url);
  const payload = await readPayload(request);

  const benchmarkId = String(payload?.benchmarkId || searchParams.get("benchmarkId") || "").trim();
  const confirm = String(payload?.confirm || searchParams.get("confirm") || "").trim();

  if (!benchmarkId) return json(400, { error: "benchmarkId is required." });

  const ok =
    confirm === "DELETE" ||
    confirm.toLowerCase() === `delete ${benchmarkId.toLowerCase()}`;
  if (!ok) {
    return json(400, { error: `Confirmation required. Type "DELETE" (or "DELETE ${benchmarkId}").` });
  }

  try {
    await ensureSchema();
    const sql = getSql();

    const result = await sql.begin(async (tx) => {
      const delEvals = await tx`
        WITH d AS (
          DELETE FROM evaluations
          WHERE benchmark_id = ${benchmarkId}
          RETURNING 1
        )
        SELECT COUNT(*)::int AS n FROM d
      `;

      const delRespSlots = await tx`
        WITH d AS (
          DELETE FROM response_review_slots
          WHERE benchmark_id = ${benchmarkId}
          RETURNING 1
        )
        SELECT COUNT(*)::int AS n FROM d
      `;

      const delQSlots = await tx`
        WITH d AS (
          DELETE FROM question_review_slots
          WHERE benchmark_id = ${benchmarkId}
          RETURNING 1
        )
        SELECT COUNT(*)::int AS n FROM d
      `;

      const delModels = await tx`
        WITH d AS (
          DELETE FROM benchmark_models
          WHERE benchmark_id = ${benchmarkId}
          RETURNING 1
        )
        SELECT COUNT(*)::int AS n FROM d
      `;

      const delState = await tx`
        WITH d AS (
          DELETE FROM benchmark_state
          WHERE benchmark_id = ${benchmarkId}
          RETURNING 1
        )
        SELECT COUNT(*)::int AS n FROM d
      `;

      return {
        deletedEvaluations: delEvals?.[0]?.n ?? 0,
        deletedResponseSlots: delRespSlots?.[0]?.n ?? 0,
        deletedQuestionSlots: delQSlots?.[0]?.n ?? 0,
        deletedModelMappings: delModels?.[0]?.n ?? 0,
        deletedBenchmarkState: delState?.[0]?.n ?? 0,
      };
    });

    return json(200, { ok: true, benchmarkId, ...result });
  } catch (err) {
    console.error(err);
    const msg = err?.message || "Failed to delete benchmark.";
    const isDb = msg.includes("Database not configured");
    return json(isDb ? 503 : 500, { error: isDb ? msg : "Failed to delete benchmark." });
  }
}

