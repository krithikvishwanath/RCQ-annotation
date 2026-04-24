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

function clampInt(v, { min, max, fallback }) {
  const n = typeof v === "number" ? v : Number.parseInt(String(v || ""), 10);
  if (!Number.isFinite(n)) return fallback;
  const ni = Math.trunc(n);
  return Math.min(max, Math.max(min, ni));
}

export async function GET(request) {
  const admin = checkAdminAuth(request);
  if (!admin.ok) return admin.response;

  const { searchParams } = new URL(request.url);
  const benchmarkId = String(searchParams.get("benchmarkId") || "").trim();
  const days = clampInt(searchParams.get("days"), { min: 7, max: 180, fallback: 30 });

  try {
    await ensureSchema();
    const sql = getSql();

    const where = benchmarkId ? sql`WHERE e.benchmark_id = ${benchmarkId}` : sql``;
    const whereSlots = benchmarkId ? sql`WHERE s.benchmark_id = ${benchmarkId}` : sql``;

    const [summary] = await sql`
      SELECT
        COUNT(*)::int AS total,
        SUM(CASE WHEN e.is_complete THEN 1 ELSE 0 END)::int AS complete,
        COUNT(DISTINCT e.rater_id)::int AS raters,
        MIN(e.created_at) AS first_created_at,
        MAX(e.updated_at) AS last_updated_at,
        COUNT(DISTINCT e.question_id)::int AS questions_started
      FROM evaluations e
      ${where}
    `;

    const [slots] = await sql`
      SELECT
        COUNT(*)::int AS total_slots,
        SUM(CASE WHEN s.rater_id IS NOT NULL THEN 1 ELSE 0 END)::int AS assigned_slots,
        SUM(CASE WHEN s.rater_id IS NOT NULL AND COALESCE(ev.is_complete, false) THEN 1 ELSE 0 END)::int AS complete_slots
      FROM response_review_slots s
      LEFT JOIN evaluations ev
        ON ev.rater_id = s.rater_id
        AND ev.benchmark_id = s.benchmark_id
        AND ev.question_id = s.question_id
        AND ev.model_key = s.model_key
      ${whereSlots}
    `;

    const perModel = await sql`
      SELECT
        e.model_key,
        COALESCE(bm.model_name, e.model_key) AS model_name,
        MIN(e.model_order)::int AS model_order,
        COUNT(*)::int AS total,
        SUM(CASE WHEN e.is_complete THEN 1 ELSE 0 END)::int AS complete,
        AVG(e.accuracy) FILTER (WHERE e.is_complete)::float AS avg_accuracy,
        AVG(e.completeness) FILTER (WHERE e.is_complete)::float AS avg_completeness,
        AVG(e.safety) FILTER (WHERE e.is_complete)::float AS avg_safety,
        AVG(e.communication) FILTER (WHERE e.is_complete)::float AS avg_communication,
        AVG(CASE WHEN e.harmful THEN 1 ELSE 0 END) FILTER (WHERE e.is_complete AND e.harmful IS NOT NULL)::float AS harmful_rate,
        AVG(CASE WHEN e.hallucinated THEN 1 ELSE 0 END) FILTER (WHERE e.is_complete AND e.hallucinated IS NOT NULL)::float AS hallucinated_rate
      FROM evaluations e
      LEFT JOIN benchmark_models bm
        ON bm.benchmark_id = e.benchmark_id
        AND bm.model_id = e.model_key
      ${where}
      GROUP BY e.model_key, bm.model_name
      ORDER BY model_order ASC, model_name ASC
    `;

    const daily = await sql`
      WITH series AS (
        SELECT generate_series((current_date - (${days - 1})::int), current_date, '1 day'::interval)::date AS day
      ),
      counts AS (
        SELECT
          date_trunc('day', e.updated_at)::date AS day,
          COUNT(*)::int AS complete
        FROM evaluations e
        WHERE e.is_complete = true
          AND e.updated_at >= (current_date - (${days - 1})::int)
          ${benchmarkId ? sql`AND e.benchmark_id = ${benchmarkId}` : sql``}
        GROUP BY 1
      )
      SELECT
        s.day::text AS day,
        COALESCE(c.complete, 0)::int AS complete
      FROM series s
      LEFT JOIN counts c ON c.day = s.day
      ORDER BY s.day ASC
    `;

    const perRater = await sql`
      SELECT
        r.name AS rater_name,
        COUNT(*)::int AS total,
        SUM(CASE WHEN e.is_complete THEN 1 ELSE 0 END)::int AS complete,
        MAX(e.updated_at) AS last_updated_at
      FROM evaluations e
      JOIN raters r ON r.id = e.rater_id
      ${where}
      GROUP BY r.name
      ORDER BY complete DESC, total DESC, r.name ASC
      LIMIT 50
    `;

    const [agreement] = await sql`
      WITH resp AS (
        SELECT
          e.question_id,
          e.model_key,
          COUNT(*) FILTER (WHERE e.is_complete)::int AS n_complete,
          STDDEV_SAMP(e.accuracy) FILTER (WHERE e.is_complete) AS sd_accuracy,
          STDDEV_SAMP(e.completeness) FILTER (WHERE e.is_complete) AS sd_completeness,
          STDDEV_SAMP(e.safety) FILTER (WHERE e.is_complete) AS sd_safety,
          STDDEV_SAMP(e.communication) FILTER (WHERE e.is_complete) AS sd_communication
        FROM evaluations e
        ${where}
        GROUP BY e.question_id, e.model_key
      )
      SELECT
        COUNT(*) FILTER (WHERE n_complete >= 2)::int AS responses_2plus,
        AVG(sd_accuracy) FILTER (WHERE n_complete >= 2)::float AS mean_sd_accuracy,
        AVG(sd_completeness) FILTER (WHERE n_complete >= 2)::float AS mean_sd_completeness,
        AVG(sd_safety) FILTER (WHERE n_complete >= 2)::float AS mean_sd_safety,
        AVG(sd_communication) FILTER (WHERE n_complete >= 2)::float AS mean_sd_communication
      FROM resp
    `;

    const total = summary?.total ?? 0;
    const complete = summary?.complete ?? 0;
    const completionRate = total ? complete / total : 0;

    return json(200, {
      benchmarkId: benchmarkId || null,
      days,
      summary: {
        total,
        complete,
        completionRate,
        raters: summary?.raters ?? 0,
        questionsStarted: summary?.questions_started ?? 0,
        firstCreatedAt: summary?.first_created_at ?? null,
        lastUpdatedAt: summary?.last_updated_at ?? null,
      },
      slots: {
        total: slots?.total_slots ?? 0,
        assigned: slots?.assigned_slots ?? 0,
        complete: slots?.complete_slots ?? 0,
      },
      perModel: perModel.map((m) => ({
        modelKey: m.model_key,
        modelName: m.model_name,
        modelOrder: m.model_order,
        total: m.total,
        complete: m.complete,
        averages: {
          clinicalCorrectness: m.avg_accuracy,
          completeness: m.avg_completeness,
          safetyHarmAvoidance: m.avg_safety,
          clarityForClinicians: m.avg_communication,
        },
        flags: {
          harmfulRate: m.harmful_rate,
          hallucinatedRate: m.hallucinated_rate,
        },
      })),
      dailyComplete: daily.map((d) => ({ day: d.day, complete: d.complete })),
      perRater: perRater.map((r) => ({
        raterName: r.rater_name,
        total: r.total,
        complete: r.complete,
        lastUpdatedAt: r.last_updated_at ?? null,
      })),
      agreement: {
        responses2Plus: agreement?.responses_2plus ?? 0,
        meanStddev: {
          clinicalCorrectness: agreement?.mean_sd_accuracy ?? null,
          completeness: agreement?.mean_sd_completeness ?? null,
          safetyHarmAvoidance: agreement?.mean_sd_safety ?? null,
          clarityForClinicians: agreement?.mean_sd_communication ?? null,
        },
      },
    });
  } catch (err) {
    console.error(err);
    const msg = err?.message || "Failed to load stats.";
    const isDb = msg.includes("Database not configured");
    return json(isDb ? 503 : 500, { error: isDb ? msg : "Failed to load stats." });
  }
}

