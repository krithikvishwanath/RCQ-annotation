"use client";

import { useEffect, useMemo, useState } from "react";

const C = {
  bg: "#F3F4F6",
  surface: "#FFFFFF",
  surfAlt: "#F0F1F4",
  bdr: "#D5D8DF",
  ink: "#1C2029",
  inkS: "#4D5567",
  inkM: "#929AAB",
  ac: "#3B6ED5",
  acL: "#E6EDFB",
  ok: "#1A8F62",
  okL: "#E4F6EE",
  dn: "#C73D4D",
  dnL: "#FDE9EB",
  wn: "#B87610",
};

const sans = '"Segoe UI", system-ui, -apple-system, sans-serif';

function fmtPct(v) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  return `${Math.round(Number(v) * 100)}%`;
}

function fmtNum(v, digits = 2) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  const p = Math.pow(10, digits);
  return String(Math.round(n * p) / p);
}

function fmtDate(v) {
  try {
    if (!v) return "—";
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString();
  } catch {
    return "—";
  }
}

function cardStyle() {
  return {
    border: `1px solid ${C.bdr}`,
    borderRadius: 12,
    background: C.surface,
    padding: "12px 12px",
    minWidth: 180,
  };
}

function MiniLineChart({ points, width = 560, height = 120 }) {
  const max = Math.max(1, ...points.map((p) => p.y || 0));
  const pad = 10;
  const w = width - pad * 2;
  const h = height - pad * 2;

  const path = points
    .map((p, i) => {
      const x = pad + (points.length <= 1 ? 0 : (i / (points.length - 1)) * w);
      const y = pad + h - (Math.max(0, p.y || 0) / max) * h;
      return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} style={{ display: "block", width: "100%", height: "auto" }}>
      <rect x="0" y="0" width={width} height={height} rx="10" fill={C.surfAlt} />
      <path d={path} fill="none" stroke={C.ac} strokeWidth="2.5" />
      <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="#c9ced8" />
      <text x={width - pad} y={pad + 10} textAnchor="end" fontSize="10" fontWeight="800" fill={C.inkM} fontFamily={sans}>
        max {max}
      </text>
    </svg>
  );
}

function MiniBarChart({ bars, width = 560, height = 160, color = C.ac }) {
  const max = Math.max(1, ...bars.map((b) => b.value || 0));
  const pad = 12;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const gap = 6;
  const bw = bars.length ? (w - gap * (bars.length - 1)) / bars.length : 0;

  return (
    <svg width={width} height={height} style={{ display: "block", width: "100%", height: "auto" }}>
      <rect x="0" y="0" width={width} height={height} rx="10" fill={C.surfAlt} />
      {bars.map((b, i) => {
        const v = Math.max(0, b.value || 0);
        const bh = (v / max) * h;
        const x = pad + i * (bw + gap);
        const y = pad + (h - bh);
        return (
          <g key={`${b.label}-${i}`}>
            <rect x={x} y={y} width={bw} height={bh} rx="6" fill={color} opacity="0.9" />
          </g>
        );
      })}
      <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="#c9ced8" />
      <text x={width - pad} y={pad + 10} textAnchor="end" fontSize="10" fontWeight="800" fill={C.inkM} fontFamily={sans}>
        max {max}
      </text>
    </svg>
  );
}

export default function StatsClient({ benchmarkIds, defaultBenchmarkId }) {
  const uniqueBenchmarks = useMemo(() => {
    const ids = Array.isArray(benchmarkIds) ? benchmarkIds.map((x) => String(x || "").trim()).filter(Boolean) : [];
    return Array.from(new Set(ids));
  }, [benchmarkIds]);

  const [benchmarkId, setBenchmarkId] = useState(defaultBenchmarkId || uniqueBenchmarks[0] || "");
  const [days, setDays] = useState(30);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [status, setStatus] = useState("idle"); // idle | loading | error
  const [error, setError] = useState("");
  const [data, setData] = useState(null);

  useEffect(() => {
    if (!uniqueBenchmarks.length) return;
    if (!benchmarkId) setBenchmarkId(defaultBenchmarkId || uniqueBenchmarks[0]);
  }, [uniqueBenchmarks, benchmarkId, defaultBenchmarkId]);

  useEffect(() => {
    if (!benchmarkId) return;
    let cancelled = false;

    async function load() {
      setError("");
      setStatus("loading");
      try {
        const res = await fetch(
          `/api/admin/stats?benchmarkId=${encodeURIComponent(benchmarkId)}&days=${encodeURIComponent(String(days))}`,
          { cache: "no-store" },
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error || `Failed to load stats (${res.status}).`);
        if (cancelled) return;
        setData(body);
        setStatus("idle");
      } catch (e) {
        if (cancelled) return;
        setError(e?.message || "Failed to load stats.");
        setStatus("error");
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [benchmarkId, days, refreshNonce]);

  useEffect(() => {
    const handler = () => {
      setRefreshNonce((n) => n + 1);
    };
    window.addEventListener("clinbench.admin.refresh", handler);
    return () => window.removeEventListener("clinbench.admin.refresh", handler);
  }, []);

  const dailyPoints = useMemo(() => {
    const rows = data?.dailyComplete || [];
    return rows.map((r, i) => ({ x: i, y: r.complete || 0, label: r.day }));
  }, [data]);

  const perModel = useMemo(() => {
    const rows = Array.isArray(data?.perModel) ? data.perModel : [];
    return rows.slice().sort((a, b) => (a.modelOrder ?? 0) - (b.modelOrder ?? 0));
  }, [data]);

  const perModelBars = useMemo(() => {
    return perModel.map((m) => ({
      label: m.modelKey,
      value: m.complete || 0,
    }));
  }, [perModel]);

  const selectStyle = {
    width: "100%",
    padding: "8px 10px",
    borderRadius: 8,
    border: `1px solid ${C.bdr}`,
    fontSize: 12,
    fontWeight: 700,
    background: "#fff",
    color: C.inkS,
    cursor: "pointer",
    fontFamily: sans,
  };

  const summary = data?.summary || {};
  const slots = data?.slots || {};
  const agree = data?.agreement || {};

  return (
    <div style={{ marginTop: 18, maxWidth: 1200, fontFamily: sans }}>
      <h2 style={{ margin: "0 0 8px", fontSize: 14 }}>Review stats</h2>
      <div style={{ fontSize: 12, color: C.inkS, lineHeight: 1.5, marginBottom: 10 }}>
        Aggregated progress and basic quality signals (computed from saved evaluations).
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div style={{ minWidth: 260 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: C.inkS, marginBottom: 4 }}>Benchmark</div>
          <select value={benchmarkId} onChange={(e) => setBenchmarkId(e.target.value)} style={selectStyle}>
            {(uniqueBenchmarks.length ? uniqueBenchmarks : [benchmarkId || "(none)"]).map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>

        <div style={{ minWidth: 220 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: C.inkS, marginBottom: 4 }}>Window</div>
          <select value={String(days)} onChange={(e) => setDays(Number(e.target.value))} style={selectStyle}>
            <option value="14">Last 14 days</option>
            <option value="30">Last 30 days</option>
            <option value="60">Last 60 days</option>
            <option value="90">Last 90 days</option>
          </select>
        </div>

        <div style={{ marginLeft: "auto", fontSize: 11, color: C.inkM }}>
          {status === "loading" ? "Loading…" : summary?.lastUpdatedAt ? `Last update: ${fmtDate(summary.lastUpdatedAt)}` : null}
        </div>
      </div>

      {error ? (
        <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 10, border: `1px solid ${C.dn}35`, background: C.dnL, color: C.dn, fontSize: 12, fontWeight: 800 }}>
          {error}
        </div>
      ) : null}

      <div style={{ marginTop: 12, display: "flex", gap: 10, flexWrap: "wrap" }}>
        <div style={cardStyle()}>
          <div style={{ fontSize: 10, fontWeight: 900, color: C.inkM, textTransform: "uppercase", letterSpacing: "0.05em" }}>Completion</div>
          <div style={{ marginTop: 6, display: "flex", alignItems: "baseline", gap: 8 }}>
            <div style={{ fontSize: 22, fontWeight: 950, color: C.ink }}>{fmtPct(summary.completionRate)}</div>
            <div style={{ fontSize: 12, color: C.inkM, fontWeight: 800 }}>
              {summary.complete ?? 0}/{summary.total ?? 0}
            </div>
          </div>
        </div>

        <div style={cardStyle()}>
          <div style={{ fontSize: 10, fontWeight: 900, color: C.inkM, textTransform: "uppercase", letterSpacing: "0.05em" }}>Reviewers</div>
          <div style={{ marginTop: 6, fontSize: 22, fontWeight: 950, color: C.ink }}>{summary.raters ?? 0}</div>
          <div style={{ marginTop: 2, fontSize: 11, color: C.inkM, fontWeight: 700 }}>with any saved evaluation</div>
        </div>

        <div style={cardStyle()}>
          <div style={{ fontSize: 10, fontWeight: 900, color: C.inkM, textTransform: "uppercase", letterSpacing: "0.05em" }}>Response slots</div>
          <div style={{ marginTop: 6, fontSize: 22, fontWeight: 950, color: C.ink }}>{slots.complete ?? 0}</div>
          <div style={{ marginTop: 2, fontSize: 11, color: C.inkM, fontWeight: 700 }}>
            complete · {slots.assigned ?? 0} assigned · {slots.total ?? 0} total
          </div>
        </div>

        <div style={cardStyle()}>
          <div style={{ fontSize: 10, fontWeight: 900, color: C.inkM, textTransform: "uppercase", letterSpacing: "0.05em" }}>Agreement (rough)</div>
          <div style={{ marginTop: 6, fontSize: 12, color: C.inkS, lineHeight: 1.45, fontWeight: 800 }}>
            {agree.responses2Plus ?? 0} responses with 2+ complete ratings
          </div>
          <div style={{ marginTop: 6, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, fontSize: 11, color: C.inkM, fontWeight: 800 }}>
            <div>CC sd: {fmtNum(agree?.meanStddev?.clinicalCorrectness, 2)}</div>
            <div>Comp sd: {fmtNum(agree?.meanStddev?.completeness, 2)}</div>
            <div>Safety sd: {fmtNum(agree?.meanStddev?.safetyHarmAvoidance, 2)}</div>
            <div>Clarity sd: {fmtNum(agree?.meanStddev?.clarityForClinicians, 2)}</div>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 10, alignItems: "stretch" }}>
        <div style={{ border: `1px solid ${C.bdr}`, borderRadius: 12, background: C.surface, padding: 12 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 950, color: C.inkS }}>Completed ratings / day</div>
            <div style={{ fontSize: 11, fontWeight: 800, color: C.inkM }}>{days}d window</div>
          </div>
          <div style={{ marginTop: 10 }}>
            <MiniLineChart points={dailyPoints} />
          </div>
        </div>

        <div style={{ border: `1px solid ${C.bdr}`, borderRadius: 12, background: C.surface, padding: 12 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
            <div style={{ fontSize: 12, fontWeight: 950, color: C.inkS }}>Completed by model</div>
            <div style={{ fontSize: 11, fontWeight: 800, color: C.inkM }}>{perModel.length} models</div>
          </div>
          <div style={{ marginTop: 10 }}>
            <MiniBarChart bars={perModelBars} />
          </div>
        </div>
      </div>

      <div style={{ marginTop: 12, border: `1px solid ${C.bdr}`, borderRadius: 12, background: C.surface, padding: 12 }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 950, color: C.inkS }}>Per-model averages (completed only)</div>
          <div style={{ fontSize: 11, fontWeight: 800, color: C.inkM }}>
            CC/Comp/Safety/Clarity are 1–4 · flags are rates
          </div>
        </div>

        <div style={{ marginTop: 10, overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 760 }}>
            <thead style={{ background: C.surfAlt }}>
              <tr>
                <th style={{ textAlign: "left", padding: "10px 12px", borderBottom: `1px solid ${C.bdr}` }}>Model</th>
                <th style={{ textAlign: "right", padding: "10px 12px", borderBottom: `1px solid ${C.bdr}` }}>Complete</th>
                <th style={{ textAlign: "right", padding: "10px 12px", borderBottom: `1px solid ${C.bdr}` }}>CC</th>
                <th style={{ textAlign: "right", padding: "10px 12px", borderBottom: `1px solid ${C.bdr}` }}>Comp</th>
                <th style={{ textAlign: "right", padding: "10px 12px", borderBottom: `1px solid ${C.bdr}` }}>Safety</th>
                <th style={{ textAlign: "right", padding: "10px 12px", borderBottom: `1px solid ${C.bdr}` }}>Clarity</th>
                <th style={{ textAlign: "right", padding: "10px 12px", borderBottom: `1px solid ${C.bdr}` }}>Harm</th>
                <th style={{ textAlign: "right", padding: "10px 12px", borderBottom: `1px solid ${C.bdr}` }}>Halluc</th>
              </tr>
            </thead>
            <tbody>
              {perModel.length ? (
                perModel.map((m) => (
                  <tr key={m.modelKey}>
                    <td style={{ padding: "10px 12px", borderBottom: `1px solid ${C.bdr}` }}>
                      <div style={{ fontWeight: 950, color: C.inkS }}>{m.modelKey}</div>
                      <div style={{ fontSize: 11, color: C.inkM, marginTop: 2 }}>{m.modelName}</div>
                    </td>
                    <td style={{ padding: "10px 12px", borderBottom: `1px solid ${C.bdr}`, textAlign: "right", fontWeight: 900, color: C.ok }}>
                      {m.complete ?? 0}
                    </td>
                    <td style={{ padding: "10px 12px", borderBottom: `1px solid ${C.bdr}`, textAlign: "right", fontWeight: 900, color: C.inkS }}>
                      {fmtNum(m?.averages?.clinicalCorrectness, 2)}
                    </td>
                    <td style={{ padding: "10px 12px", borderBottom: `1px solid ${C.bdr}`, textAlign: "right", fontWeight: 900, color: C.inkS }}>
                      {fmtNum(m?.averages?.completeness, 2)}
                    </td>
                    <td style={{ padding: "10px 12px", borderBottom: `1px solid ${C.bdr}`, textAlign: "right", fontWeight: 900, color: C.inkS }}>
                      {fmtNum(m?.averages?.safetyHarmAvoidance, 2)}
                    </td>
                    <td style={{ padding: "10px 12px", borderBottom: `1px solid ${C.bdr}`, textAlign: "right", fontWeight: 900, color: C.inkS }}>
                      {fmtNum(m?.averages?.clarityForClinicians, 2)}
                    </td>
                    <td style={{ padding: "10px 12px", borderBottom: `1px solid ${C.bdr}`, textAlign: "right", fontWeight: 900, color: C.dn }}>
                      {m?.flags?.harmfulRate == null ? "—" : fmtPct(m.flags.harmfulRate)}
                    </td>
                    <td style={{ padding: "10px 12px", borderBottom: `1px solid ${C.bdr}`, textAlign: "right", fontWeight: 900, color: C.wn }}>
                      {m?.flags?.hallucinatedRate == null ? "—" : fmtPct(m.flags.hallucinatedRate)}
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={8} style={{ padding: "12px", color: C.inkM }}>
                    {status === "loading" ? "Loading…" : "No evaluations found for this benchmark yet."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

