"use client";

import { useEffect, useMemo, useRef, useState } from "react";

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

function slotKey(s) {
  return `${s.questionId}::${s.modelKey}::${s.slot}`;
}

function safeJson(v, fallback) {
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

export default function AssignmentManager({ benchmarkIds, defaultBenchmarkId }) {
  const [benchmarkId, setBenchmarkId] = useState(defaultBenchmarkId || (benchmarkIds?.[0] || ""));
  const [raters, setRaters] = useState([]);
  const [slots, setSlots] = useState([]);
  const [bench, setBench] = useState(null);

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("idle"); // idle | loading | saving | error
  const [error, setError] = useState("");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const inFlightRef = useRef(0);

  const [bulkFrom, setBulkFrom] = useState("");
  const [bulkTo, setBulkTo] = useState("");
  const [bulkCount, setBulkCount] = useState(50);
  const [bulkResult, setBulkResult] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/benchmark.json", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setBench(data);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handler = () => setRefreshNonce((n) => n + 1);
    window.addEventListener("clinbench.admin.refresh", handler);
    return () => window.removeEventListener("clinbench.admin.refresh", handler);
  }, []);

  useEffect(() => {
    if (!benchmarkId) return;
    let cancelled = false;
    setError("");
    setStatus("loading");
    (async () => {
      try {
        const res = await fetch(`/api/admin/response-assignments?benchmarkId=${encodeURIComponent(benchmarkId)}`, {
          cache: "no-store",
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || "Failed to load assignments.");
        if (cancelled) return;
        setRaters(Array.isArray(data.raters) ? data.raters : []);
        setSlots(Array.isArray(data.slots) ? data.slots : []);
        setStatus("idle");
      } catch (e) {
        if (cancelled) return;
        setError(e?.message || "Failed to load assignments.");
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [benchmarkId, refreshNonce]);

  const questionTextById = useMemo(() => {
    const map = {};
    const qs = bench?.questions || [];
    for (const q of qs) {
      if (!q?.id) continue;
      map[String(q.id)] = String(q.query || "");
    }
    return map;
  }, [bench]);

  const filteredSlots = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return slots;
    return (slots || []).filter((s) => {
      const id = `${s.questionId} ${s.modelKey} slot:${s.slot} ${s.raterName || ""}`.toLowerCase();
      const qt = String(questionTextById[String(s.questionId)] || "").toLowerCase();
      return id.includes(q) || qt.includes(q);
    });
  }, [slots, query, questionTextById]);

  const columns = useMemo(() => {
    const col = {
      unassigned: { id: "unassigned", title: "Unassigned", raterId: null, items: [] },
    };
    for (const r of raters) {
      col[r.id] = { id: r.id, title: r.name, raterId: r.id, items: [] };
    }
    for (const s of filteredSlots) {
      const k = s.raterId && col[s.raterId] ? s.raterId : "unassigned";
      col[k].items.push(s);
    }
    return Object.values(col);
  }, [raters, filteredSlots]);

  const totals = useMemo(() => {
    let total = slots.length;
    let unassigned = 0;
    let complete = 0;
    let unstarted = 0;
    for (const s of slots) {
      if (!s.raterId) unassigned++;
      if (s.isComplete) complete++;
      if (s.raterId && !s.hasEval) unstarted++;
    }
    return { total, unassigned, complete, unstarted };
  }, [slots]);

  const bulkAvailable = useMemo(() => {
    if (!bulkFrom) return 0;
    return (slots || []).filter((s) => s.raterId === bulkFrom && !s.hasEval).length;
  }, [slots, bulkFrom]);

  async function bulkMove() {
    if (!benchmarkId) return;
    if (!bulkFrom) return;
    if (bulkTo && bulkTo === bulkFrom) return;
    const n = Number.parseInt(String(bulkCount || ""), 10);
    if (!Number.isInteger(n) || n < 1) return;

    setBulkResult("");
    setError("");
    setStatus("saving");

    try {
      const res = await fetch("/api/admin/response-assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          benchmarkId,
          fromRaterId: bulkFrom,
          toRaterId: bulkTo || null,
          count: n,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Bulk move failed.");

      setBulkResult(`Moved ${data?.moved ?? 0} unstarted slot(s).`);
      setStatus("idle");
      setRefreshNonce((x) => x + 1);
    } catch (e) {
      setError(e?.message || "Bulk move failed.");
      setStatus("error");
    }
  }

  async function updateAssignment(s, toRaterId) {
    if (!benchmarkId) return;
    setError("");
    setStatus("saving");

    const prevSlots = slots;
    const nextSlots = prevSlots.map((x) => {
      if (slotKey(x) !== slotKey(s)) return x;
      const name = toRaterId ? (raters.find((r) => r.id === toRaterId)?.name || null) : null;
      return { ...x, raterId: toRaterId || null, raterName: name };
    });
    setSlots(nextSlots);

    inFlightRef.current += 1;
    const myFlight = inFlightRef.current;

    try {
      const res = await fetch("/api/admin/response-assignments", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          benchmarkId,
          questionId: s.questionId,
          modelKey: s.modelKey,
          slot: s.slot,
          raterId: toRaterId || null,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Failed to update assignment.");
      if (myFlight === inFlightRef.current) setStatus("idle");
    } catch (e) {
      setSlots(prevSlots);
      setError(e?.message || "Failed to update assignment.");
      setStatus("error");
    }
  }

  function onDragStart(e, s) {
    e.dataTransfer.setData("text/plain", JSON.stringify({ slot: s }));
    e.dataTransfer.effectAllowed = "move";
  }

  function onDrop(e, raterId) {
    e.preventDefault();
    const raw = e.dataTransfer.getData("text/plain");
    const data = safeJson(raw, null);
    const s = data?.slot;
    if (!s) return;
    updateAssignment(s, raterId);
  }

  function allowDrop(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }

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

  return (
    <div style={{ marginTop: 22, maxWidth: 1200 }}>
      <h2 style={{ margin: "0 0 8px", fontSize: 14 }}>Assignment manager (response-level)</h2>
      <div style={{ fontSize: 12, color: C.inkS, lineHeight: 1.5, marginBottom: 10 }}>
        Each card is one <b>(question × model response × slot)</b>. Drag to reassign, or use the dropdown.
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div style={{ minWidth: 240 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: C.inkS, marginBottom: 4 }}>Benchmark</div>
          <select value={benchmarkId} onChange={(e) => setBenchmarkId(e.target.value)} style={selectStyle}>
            {(benchmarkIds?.length ? benchmarkIds : [benchmarkId || "(none)"]).map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </div>

        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: C.inkS, marginBottom: 4 }}>Search (question id, model, rater, or prompt text)</div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder='e.g. "36948" or "Model_A" or "discharge instructions"'
            style={{
              width: "100%",
              padding: "9px 10px",
              borderRadius: 8,
              border: `1px solid ${C.bdr}`,
              fontSize: 12,
              fontWeight: 600,
              color: C.ink,
              outline: "none",
              fontFamily: sans,
            }}
          />
        </div>

        <div style={{ minWidth: 220 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: C.inkS, marginBottom: 4 }}>Totals</div>
          <div style={{ fontSize: 12, color: C.inkS, background: C.surfAlt, border: `1px solid ${C.bdr}`, borderRadius: 10, padding: "9px 10px" }}>
            <b>{totals.total}</b> slots · <b>{totals.unassigned}</b> unassigned · <b>{totals.unstarted}</b> unstarted · <b>{totals.complete}</b> complete
          </div>
        </div>
      </div>

      <div style={{ marginTop: 12, border: `1px solid ${C.bdr}`, borderRadius: 12, padding: "10px 12px", background: C.surfAlt }}>
        <div style={{ fontSize: 12, fontWeight: 900, color: C.inkS, marginBottom: 8 }}>Bulk move (random, unstarted only)</div>
        <div style={{ fontSize: 11, color: C.inkM, lineHeight: 1.45, marginBottom: 10 }}>
          Moves a random set of slots currently assigned to a reviewer where the reviewer has <b>no saved evaluation</b> yet.
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div style={{ minWidth: 240 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: C.inkS, marginBottom: 4 }}>From reviewer</div>
            <select value={bulkFrom} onChange={(e) => setBulkFrom(e.target.value)} style={selectStyle}>
              <option value="">(select)</option>
              {raters.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>

          <div style={{ minWidth: 240 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: C.inkS, marginBottom: 4 }}>To</div>
            <select value={bulkTo} onChange={(e) => setBulkTo(e.target.value)} style={selectStyle}>
              <option value="">(unassigned)</option>
              {raters.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>

          <div style={{ minWidth: 140 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: C.inkS, marginBottom: 4 }}>Count</div>
            <input
              value={bulkCount}
              onChange={(e) => setBulkCount(e.target.value)}
              inputMode="numeric"
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: 8,
                border: `1px solid ${C.bdr}`,
                fontSize: 12,
                fontWeight: 700,
                color: C.inkS,
                outline: "none",
                fontFamily: sans,
                background: "#fff",
              }}
            />
          </div>

          <div>
            <button
              onClick={bulkMove}
              disabled={
                status === "loading" ||
                status === "saving" ||
                !benchmarkId ||
                !bulkFrom ||
                (bulkTo && bulkTo === bulkFrom) ||
                !Number.isInteger(Number.parseInt(String(bulkCount || ""), 10)) ||
                Number.parseInt(String(bulkCount || ""), 10) < 1
              }
              style={{
                padding: "10px 12px",
                borderRadius: 9,
                border: "none",
                background:
                  status === "loading" ||
                  status === "saving" ||
                  !benchmarkId ||
                  !bulkFrom ||
                  (bulkTo && bulkTo === bulkFrom)
                    ? C.bdr
                    : C.ac,
                color: "#fff",
                fontWeight: 900,
                fontSize: 12,
                cursor:
                  status === "loading" ||
                  status === "saving" ||
                  !benchmarkId ||
                  !bulkFrom ||
                  (bulkTo && bulkTo === bulkFrom)
                    ? "not-allowed"
                    : "pointer",
              }}
            >
              {status === "saving" ? "Moving…" : "Move random"}
            </button>
          </div>

          <div style={{ fontSize: 11, color: C.inkM, paddingBottom: 2 }}>
            Available unstarted for selected reviewer: <b>{bulkAvailable}</b>
          </div>
        </div>

        {bulkResult ? (
          <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 10, border: `1px solid ${C.ok}35`, background: C.okL, color: C.ok, fontSize: 12, fontWeight: 800 }}>
            {bulkResult}
          </div>
        ) : null}
      </div>

      {error ? (
        <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 10, border: `1px solid ${C.dn}35`, background: C.dnL, color: C.dn, fontSize: 12, fontWeight: 700 }}>
          {error}
        </div>
      ) : null}

      <div style={{ marginTop: 12, display: "flex", gap: 10, overflowX: "auto", paddingBottom: 6 }}>
        {columns.map((col) => {
          const isUnassigned = col.id === "unassigned";
          return (
            <div
              key={col.id}
              onDrop={(e) => onDrop(e, col.raterId)}
              onDragOver={allowDrop}
              style={{
                width: 320,
                minWidth: 320,
                background: C.surface,
                border: `1px solid ${C.bdr}`,
                borderRadius: 12,
                overflow: "hidden",
                flexShrink: 0,
              }}
            >
              <div style={{ padding: "10px 12px", borderBottom: `1px solid ${C.bdr}`, background: isUnassigned ? C.surfAlt : C.surface }}>
                <div style={{ fontSize: 12, fontWeight: 900, color: C.ink, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{col.title}</span>
                  <span style={{ fontSize: 10, fontWeight: 900, color: C.inkM }}>{col.items.length}</span>
                </div>
              </div>

              <div style={{ maxHeight: 520, overflowY: "auto", padding: 10, background: C.bg }}>
                {col.items.length ? (
                  col.items.map((s) => {
                    const qText = questionTextById[String(s.questionId)] || "";
                    const badge = s.isComplete
                      ? { bg: C.okL, fg: C.ok, label: "Complete" }
                      : s.hasEval
                        ? { bg: C.acL, fg: C.ac, label: "In progress" }
                        : { bg: "#FEF5E8", fg: C.wn, label: "Unstarted" };

                    return (
                      <div
                        key={slotKey(s)}
                        draggable
                        onDragStart={(e) => onDragStart(e, s)}
                        style={{
                          background: C.surface,
                          border: `1px solid ${C.bdr}`,
                          borderRadius: 10,
                          padding: "10px 10px",
                          marginBottom: 8,
                          cursor: "grab",
                        }}
                        title={qText ? qText : `${s.questionId}`}
                      >
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                          <div style={{ fontWeight: 900, fontSize: 12, color: C.inkS }}>{s.questionId}</div>
                          <span style={{ fontSize: 9, fontWeight: 900, color: badge.fg, background: badge.bg, padding: "2px 7px", borderRadius: 999 }}>
                            {badge.label}
                          </span>
                        </div>
                        <div style={{ marginTop: 4, fontSize: 11, color: C.inkM, display: "flex", justifyContent: "space-between", gap: 8 }}>
                          <span style={{ fontWeight: 800 }}>{s.modelKey}</span>
                          <span style={{ fontWeight: 800 }}>{`slot ${s.slot + 1}/3`}</span>
                        </div>
                        {qText ? (
                          <div style={{ marginTop: 6, fontSize: 10.5, color: C.inkS, lineHeight: 1.35 }}>
                            {qText.length > 110 ? `${qText.slice(0, 110)}…` : qText}
                          </div>
                        ) : null}

                        <div style={{ marginTop: 8 }}>
                          <select
                            value={s.raterId || ""}
                            onChange={(e) => updateAssignment(s, e.target.value || null)}
                            style={{
                              width: "100%",
                              padding: "7px 8px",
                              borderRadius: 8,
                              border: `1px solid ${C.bdr}`,
                              fontSize: 11,
                              fontWeight: 700,
                              color: C.inkS,
                              background: "#fff",
                              cursor: "pointer",
                              fontFamily: sans,
                            }}
                          >
                            <option value="">(unassigned)</option>
                            {raters.map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <div style={{ padding: "10px 6px", fontSize: 12, color: C.inkM }}>
                    {status === "loading" ? "Loading…" : "No matching slots."}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

