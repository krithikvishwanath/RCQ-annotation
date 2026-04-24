import { ensureSchema } from "../../../../lib/server/schema";
import { getSql } from "../../../../lib/server/db";

export const runtime = "nodejs";

function csvEscape(value) {
  if (value == null) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const benchmarkId = searchParams.get("benchmarkId");

  let sql;
  try {
    await ensureSchema();
    sql = getSql();
  } catch (err) {
    console.error(err);
    const msg = err?.message || "Failed to connect to database.";
    const isDb = msg.includes("Database not configured");
    return new Response(isDb ? msg : "Failed to export.", {
      status: isDb ? 503 : 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const rows = benchmarkId
    ? await sql`
        SELECT
          r.name AS rater_name,
          e.benchmark_id,
          e.question_id,
          e.model_key,
          bm.model_name,
          e.model_order,
          e.accuracy AS clinical_correctness,
          e.completeness,
          e.safety AS safety_harm_avoidance,
          e.communication AS clarity_for_clinicians,
          e.harmful,
          e.hallucinated,
          e.notes,
          e.is_complete,
          e.created_at,
          e.updated_at
        FROM evaluations e
        JOIN raters r ON r.id = e.rater_id
        LEFT JOIN benchmark_models bm
          ON bm.benchmark_id = e.benchmark_id
          AND bm.model_id = e.model_key
        WHERE e.benchmark_id = ${benchmarkId}
        ORDER BY e.updated_at ASC
      `
    : await sql`
        SELECT
          r.name AS rater_name,
          e.benchmark_id,
          e.question_id,
          e.model_key,
          bm.model_name,
          e.model_order,
          e.accuracy AS clinical_correctness,
          e.completeness,
          e.safety AS safety_harm_avoidance,
          e.communication AS clarity_for_clinicians,
          e.harmful,
          e.hallucinated,
          e.notes,
          e.is_complete,
          e.created_at,
          e.updated_at
        FROM evaluations e
        JOIN raters r ON r.id = e.rater_id
        LEFT JOIN benchmark_models bm
          ON bm.benchmark_id = e.benchmark_id
          AND bm.model_id = e.model_key
        ORDER BY e.updated_at ASC
      `;

  const headers = [
    "rater_name",
    "benchmark_id",
    "question_id",
    "model_key",
    "model_name",
    "model_order",
    "clinical_correctness",
    "completeness",
    "safety_harm_avoidance",
    "clarity_for_clinicians",
    "harmful",
    "hallucinated",
    "notes",
    "is_complete",
    "created_at",
    "updated_at",
  ];

  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(headers.map((h) => csvEscape(r[h])).join(","));
  }

  const filename = benchmarkId
    ? `clinbench_evaluations_${benchmarkId}.csv`
    : "clinbench_evaluations.csv";

  return new Response(lines.join("\n"), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

