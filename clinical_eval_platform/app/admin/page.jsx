import { ensureSchema } from "../../lib/server/schema";
import { getSql } from "../../lib/server/db";
import ResetClient from "./ResetClient";
import AssignmentManager from "./AssignmentManager";
import RaterManager from "./RaterManager";
import StatsClient from "./StatsClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminPage() {
  let error = null;
  let benchmarks = [];
  let raters = [];
  let modelMapping = [];
  let benchmarkIds = [];

  try {
    await ensureSchema();
    const sql = getSql();

    const ids = await sql`
      SELECT DISTINCT benchmark_id
      FROM response_review_slots
      UNION
      SELECT DISTINCT benchmark_id
      FROM evaluations
      UNION
      SELECT DISTINCT benchmark_id
      FROM benchmark_models
      UNION
      SELECT benchmark_id
      FROM benchmark_state
      ORDER BY benchmark_id DESC
    `;
    benchmarkIds = (ids || []).map((r) => r.benchmark_id).filter(Boolean);

    benchmarks = await sql`
      SELECT
        benchmark_id,
        COUNT(*)::int AS total,
        SUM(CASE WHEN is_complete THEN 1 ELSE 0 END)::int AS complete
      FROM evaluations
      GROUP BY benchmark_id
      ORDER BY MAX(updated_at) DESC
    `;

    raters = await sql`
      SELECT
        r.name AS rater_name,
        e.benchmark_id,
        COUNT(*)::int AS total,
        SUM(CASE WHEN e.is_complete THEN 1 ELSE 0 END)::int AS complete
      FROM evaluations e
      JOIN raters r ON r.id = e.rater_id
      GROUP BY r.name, e.benchmark_id
      ORDER BY r.name ASC
    `;

    modelMapping = await sql`
      SELECT
        benchmark_id,
        model_id,
        model_name,
        model_order
      FROM benchmark_models
      ORDER BY benchmark_id DESC, model_order ASC
    `;
  } catch (e) {
    error = e?.message || "Failed to load admin data.";
  }

  const defaultBenchmarkId =
    modelMapping?.[0]?.benchmark_id ||
    benchmarks?.[0]?.benchmark_id ||
    benchmarkIds?.[0] ||
    "";

  return (
    <div style={{ fontFamily: '"Segoe UI", system-ui, -apple-system, sans-serif', padding: 24 }}>
      <h1 style={{ margin: "0 0 6px", fontSize: 20 }}>ClinBench Admin</h1>
      <p style={{ margin: "0 0 18px", color: "#4D5567", fontSize: 13 }}>
        Download consolidated rating data as CSV.
      </p>

      {error ? (
        <div
          style={{
            padding: "10px 12px",
            border: "1px solid #F3B1B8",
            background: "#FDE9EB",
            color: "#C73D4D",
            borderRadius: 8,
            maxWidth: 860,
            fontSize: 13,
          }}
        >
          {error}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 14 }}>
        <a
          href="/api/admin/export"
          style={{
            display: "inline-block",
            padding: "8px 12px",
            borderRadius: 8,
            background: "#3B6ED5",
            color: "#fff",
            fontSize: 12,
            fontWeight: 700,
            textDecoration: "none",
          }}
        >
          Download all results (CSV)
        </a>
        <span style={{ fontSize: 12, color: "#929AAB" }}>
          Tip: set `ADMIN_PASSWORD` to protect this page.
        </span>
      </div>

      {!error ? (
        <StatsClient benchmarkIds={benchmarkIds} defaultBenchmarkId={defaultBenchmarkId} />
      ) : null}

      {modelMapping.length ? (
        <div style={{ marginTop: 22, maxWidth: 980 }}>
          <h2 style={{ margin: "0 0 8px", fontSize: 14 }}>Model mapping (blinding key)</h2>
          <div style={{ border: "1px solid #D5D8DF", borderRadius: 10, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead style={{ background: "#F0F1F4" }}>
                <tr>
                  <th style={{ textAlign: "left", padding: "10px 12px", borderBottom: "1px solid #D5D8DF" }}>
                    Benchmark ID
                  </th>
                  <th style={{ textAlign: "left", padding: "10px 12px", borderBottom: "1px solid #D5D8DF" }}>
                    Model ID
                  </th>
                  <th style={{ textAlign: "left", padding: "10px 12px", borderBottom: "1px solid #D5D8DF" }}>
                    Source
                  </th>
                </tr>
              </thead>
              <tbody>
                {modelMapping.map((m) => (
                  <tr key={`${m.benchmark_id}-${m.model_id}`}>
                    <td style={{ padding: "10px 12px", borderBottom: "1px solid #D5D8DF", color: "#4D5567" }}>
                      {m.benchmark_id}
                    </td>
                    <td style={{ padding: "10px 12px", borderBottom: "1px solid #D5D8DF", fontWeight: 800 }}>
                      {m.model_id}
                    </td>
                    <td style={{ padding: "10px 12px", borderBottom: "1px solid #D5D8DF" }}>{m.model_name}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {benchmarks.length ? (
        <div style={{ marginTop: 22, maxWidth: 980 }}>
          <h2 style={{ margin: "0 0 8px", fontSize: 14 }}>Benchmarks</h2>
          <div style={{ border: "1px solid #D5D8DF", borderRadius: 10, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead style={{ background: "#F0F1F4" }}>
                <tr>
                  <th style={{ textAlign: "left", padding: "10px 12px", borderBottom: "1px solid #D5D8DF" }}>
                    Benchmark ID
                  </th>
                  <th style={{ textAlign: "right", padding: "10px 12px", borderBottom: "1px solid #D5D8DF" }}>
                    Complete
                  </th>
                  <th style={{ textAlign: "right", padding: "10px 12px", borderBottom: "1px solid #D5D8DF" }}>
                    Total
                  </th>
                  <th style={{ textAlign: "right", padding: "10px 12px", borderBottom: "1px solid #D5D8DF" }}>
                    Export
                  </th>
                </tr>
              </thead>
              <tbody>
                {benchmarks.map((b) => (
                  <tr key={b.benchmark_id}>
                    <td style={{ padding: "10px 12px", borderBottom: "1px solid #D5D8DF" }}>{b.benchmark_id}</td>
                    <td style={{ padding: "10px 12px", textAlign: "right", borderBottom: "1px solid #D5D8DF" }}>
                      {b.complete}
                    </td>
                    <td style={{ padding: "10px 12px", textAlign: "right", borderBottom: "1px solid #D5D8DF" }}>
                      {b.total}
                    </td>
                    <td style={{ padding: "10px 12px", textAlign: "right", borderBottom: "1px solid #D5D8DF" }}>
                      <a href={`/api/admin/export?benchmarkId=${encodeURIComponent(b.benchmark_id)}`}>CSV</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {raters.length ? (
        <div style={{ marginTop: 22, maxWidth: 980 }}>
          <h2 style={{ margin: "0 0 8px", fontSize: 14 }}>Rater progress</h2>
          <div style={{ border: "1px solid #D5D8DF", borderRadius: 10, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead style={{ background: "#F0F1F4" }}>
                <tr>
                  <th style={{ textAlign: "left", padding: "10px 12px", borderBottom: "1px solid #D5D8DF" }}>
                    Rater
                  </th>
                  <th style={{ textAlign: "left", padding: "10px 12px", borderBottom: "1px solid #D5D8DF" }}>
                    Benchmark ID
                  </th>
                  <th style={{ textAlign: "right", padding: "10px 12px", borderBottom: "1px solid #D5D8DF" }}>
                    Complete
                  </th>
                  <th style={{ textAlign: "right", padding: "10px 12px", borderBottom: "1px solid #D5D8DF" }}>
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {raters.map((r, i) => (
                  <tr key={`${r.rater_name}-${r.benchmark_id}-${i}`}>
                    <td style={{ padding: "10px 12px", borderBottom: "1px solid #D5D8DF" }}>{r.rater_name}</td>
                    <td style={{ padding: "10px 12px", borderBottom: "1px solid #D5D8DF" }}>{r.benchmark_id}</td>
                    <td style={{ padding: "10px 12px", textAlign: "right", borderBottom: "1px solid #D5D8DF" }}>
                      {r.complete}
                    </td>
                    <td style={{ padding: "10px 12px", textAlign: "right", borderBottom: "1px solid #D5D8DF" }}>
                      {r.total}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {!error ? (
        <RaterManager />
      ) : null}

      {!error ? (
        <AssignmentManager
          benchmarkIds={benchmarkIds}
          defaultBenchmarkId={defaultBenchmarkId}
        />
      ) : null}

      <div style={{ marginTop: 22, maxWidth: 980 }}>
        <ResetClient benchmarks={benchmarks} benchmarkIds={benchmarkIds} />
      </div>
    </div>
  );
}

