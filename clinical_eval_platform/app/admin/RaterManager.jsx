"use client";

import { useEffect, useMemo, useState } from "react";

const C = {
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
};

const sans = '"Segoe UI", system-ui, -apple-system, sans-serif';

function fmtDate(v) {
  try {
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString();
  } catch {
    return "";
  }
}

export default function RaterManager() {
  const [raters, setRaters] = useState([]);
  const [status, setStatus] = useState("idle"); // idle | loading | working | error
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");

  async function load() {
    setError("");
    setStatus("loading");
    try {
      const res = await fetch("/api/admin/raters", { cache: "no-store" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Failed to load reviewers.");
      setRaters(Array.isArray(data.raters) ? data.raters : []);
      setStatus("idle");
    } catch (e) {
      setError(e?.message || "Failed to load reviewers.");
      setStatus("error");
    }
  }

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return raters;
    return raters.filter((r) => String(r.name || "").toLowerCase().includes(q) || String(r.id || "").toLowerCase().includes(q));
  }, [raters, query]);

  async function deleteRater(r) {
    const typed = window.prompt(
      `Delete reviewer "${r.name}"?\n\nThis will:\n- delete their evaluations\n- clear their assignments\n\nType DELETE to confirm.`,
    );
    if (typed !== "DELETE") return;

    setError("");
    setStatus("working");
    try {
      const res = await fetch("/api/admin/raters", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raterId: r.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Delete failed.");

      // Refresh lists + notify other admin widgets (assignment board) to refetch.
      window.dispatchEvent(new Event("clinbench.admin.refresh"));
      await load();
      setStatus("idle");
    } catch (e) {
      setError(e?.message || "Delete failed.");
      setStatus("error");
    }
  }

  return (
    <div style={{ marginTop: 22, maxWidth: 980, fontFamily: sans }}>
      <h2 style={{ margin: "0 0 8px", fontSize: 14 }}>Reviewers</h2>
      <div style={{ margin: "0 0 10px", fontSize: 12, color: C.inkS, lineHeight: 1.5 }}>
        Delete reviewer profiles (this removes their saved evaluations and clears any response assignments).
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 260 }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: C.inkS, marginBottom: 4 }}>Search</div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name or UUID…"
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
        <div>
          <button
            onClick={load}
            disabled={status === "loading" || status === "working"}
            style={{
              padding: "9px 12px",
              borderRadius: 9,
              border: `1px solid ${C.bdr}`,
              background: "#fff",
              color: C.inkS,
              fontWeight: 800,
              fontSize: 12,
              cursor: status === "loading" || status === "working" ? "not-allowed" : "pointer",
            }}
          >
            {status === "loading" ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {error ? (
        <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 10, border: `1px solid ${C.dn}35`, background: C.dnL, color: C.dn, fontSize: 12, fontWeight: 700 }}>
          {error}
        </div>
      ) : null}

      <div style={{ marginTop: 12, border: `1px solid ${C.bdr}`, borderRadius: 10, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead style={{ background: "#F0F1F4" }}>
            <tr>
              <th style={{ textAlign: "left", padding: "10px 12px", borderBottom: `1px solid ${C.bdr}` }}>Name</th>
              <th style={{ textAlign: "left", padding: "10px 12px", borderBottom: `1px solid ${C.bdr}` }}>Created</th>
              <th style={{ textAlign: "right", padding: "10px 12px", borderBottom: `1px solid ${C.bdr}` }}>Assigned</th>
              <th style={{ textAlign: "right", padding: "10px 12px", borderBottom: `1px solid ${C.bdr}` }}>Evaluations</th>
              <th style={{ textAlign: "right", padding: "10px 12px", borderBottom: `1px solid ${C.bdr}` }}>Complete</th>
              <th style={{ textAlign: "right", padding: "10px 12px", borderBottom: `1px solid ${C.bdr}` }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length ? (
              filtered.map((r) => (
                <tr key={r.id}>
                  <td style={{ padding: "10px 12px", borderBottom: `1px solid ${C.bdr}` }}>
                    <div style={{ fontWeight: 900, color: C.inkS }}>{r.name}</div>
                    <div style={{ fontSize: 10, color: C.inkM, marginTop: 2 }}>{r.id}</div>
                  </td>
                  <td style={{ padding: "10px 12px", borderBottom: `1px solid ${C.bdr}`, color: C.inkS, fontSize: 11 }}>
                    {fmtDate(r.createdAt)}
                  </td>
                  <td style={{ padding: "10px 12px", borderBottom: `1px solid ${C.bdr}`, textAlign: "right", fontWeight: 800, color: C.inkS }}>
                    {r.assignedResponses ?? 0}
                  </td>
                  <td style={{ padding: "10px 12px", borderBottom: `1px solid ${C.bdr}`, textAlign: "right", fontWeight: 800, color: C.inkS }}>
                    {r.evaluationsTotal ?? 0}
                  </td>
                  <td style={{ padding: "10px 12px", borderBottom: `1px solid ${C.bdr}`, textAlign: "right" }}>
                    <span style={{ fontWeight: 900, color: C.ok }}>
                      {r.evaluationsComplete ?? 0}
                    </span>
                  </td>
                  <td style={{ padding: "10px 12px", borderBottom: `1px solid ${C.bdr}`, textAlign: "right" }}>
                    <button
                      onClick={() => deleteRater(r)}
                      disabled={status === "working"}
                      style={{
                        padding: "7px 10px",
                        borderRadius: 9,
                        border: "none",
                        background: status === "working" ? C.bdr : C.dn,
                        color: "#fff",
                        fontWeight: 900,
                        fontSize: 11,
                        cursor: status === "working" ? "not-allowed" : "pointer",
                      }}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} style={{ padding: "12px", color: C.inkM }}>
                  {status === "loading" ? "Loading…" : "No reviewers found."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

