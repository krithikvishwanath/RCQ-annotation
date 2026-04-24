"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

export default function ResetClient({ benchmarks, benchmarkIds: allBenchmarkIds }) {
  const router = useRouter();

  const benchmarkIds = useMemo(() => {
    const ids = Array.isArray(allBenchmarkIds) ? allBenchmarkIds.map((x) => String(x || "").trim()).filter(Boolean) : [];
    if (ids.length) return Array.from(new Set(ids));
    const fallback = Array.isArray(benchmarks) ? benchmarks.map((b) => String(b?.benchmark_id || "").trim()).filter(Boolean) : [];
    return Array.from(new Set(fallback));
  }, [benchmarks, allBenchmarkIds]);

  const [benchmarkId, setBenchmarkId] = useState(benchmarkIds[0] || "");
  const [resetAll, setResetAll] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState("idle"); // idle | working | done | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleteStatus, setDeleteStatus] = useState("idle"); // idle | working | done | error
  const [deleteResult, setDeleteResult] = useState(null);
  const [deleteError, setDeleteError] = useState("");

  useEffect(() => {
    if (!benchmarkIds.length) {
      if (benchmarkId) setBenchmarkId("");
      return;
    }
    if (!benchmarkId) {
      setBenchmarkId(benchmarkIds[0]);
      return;
    }
    if (!benchmarkIds.includes(benchmarkId)) setBenchmarkId(benchmarkIds[0]);
  }, [benchmarkIds, benchmarkId]);

  async function runReset() {
    setError("");
    setResult(null);

    const body = resetAll
      ? { all: true, confirm: confirm.trim() }
      : { benchmarkId: benchmarkId.trim(), confirm: confirm.trim() };

    if (!resetAll && !body.benchmarkId) {
      setError("Select a benchmark to reset.");
      return;
    }

    setStatus("working");
    try {
      const res = await fetch("/api/admin/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Reset failed.");
      setResult(data);
      setStatus("done");
      window.dispatchEvent(new Event("clinbench.admin.refresh"));
      router.refresh();
    } catch (e) {
      setError(e?.message || "Reset failed.");
      setStatus("error");
    }
  }

  const hint = resetAll
    ? 'Type "NUKE ALL" to confirm.'
    : 'Type "NUKE" (or "NUKE <benchmarkId>") to confirm.';

  async function runDelete() {
    setDeleteError("");
    setDeleteResult(null);

    const body = { benchmarkId: benchmarkId.trim(), confirm: deleteConfirm.trim() };
    if (!body.benchmarkId) {
      setDeleteError("Select a benchmark to delete.");
      return;
    }

    setDeleteStatus("working");
    try {
      const res = await fetch("/api/admin/delete-benchmark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Delete failed.");
      setDeleteResult(data);
      setDeleteStatus("done");
      window.dispatchEvent(new Event("clinbench.admin.refresh"));
      router.refresh();
    } catch (e) {
      setDeleteError(e?.message || "Delete failed.");
      setDeleteStatus("error");
    }
  }

  const deleteHint = benchmarkId
    ? `Type "DELETE" (or "DELETE ${benchmarkId}") to confirm.`
    : 'Type "DELETE" to confirm.';

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ border: "1px solid #F3B1B8", background: "#FDE9EB", borderRadius: 10, padding: 14 }}>
        <div style={{ fontWeight: 900, marginBottom: 6, color: "#7A0B16" }}>Danger zone: reset results</div>
        <div style={{ fontSize: 12, color: "#7A0B16", lineHeight: 1.5 }}>
          This will delete saved evaluations and clear question assignments so clinicians can start over.
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 700, color: "#7A0B16" }}>
            <input type="checkbox" checked={resetAll} onChange={(e) => setResetAll(e.target.checked)} />
            Reset ALL benchmarks
          </label>
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: "#7A0B16", marginBottom: 4 }}>Benchmark</div>
            <select
              value={benchmarkId}
              onChange={(e) => setBenchmarkId(e.target.value)}
              disabled={resetAll}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: 8,
                border: "1px solid #F3B1B8",
                fontSize: 12,
                fontWeight: 700,
                background: resetAll ? "#fff6f7" : "#fff",
                color: "#7A0B16",
                cursor: resetAll ? "not-allowed" : "pointer",
              }}
            >
              {benchmarkIds.length ? benchmarkIds.map((id) => <option key={id} value={id}>{id}</option>) : <option value="">(none)</option>}
            </select>
          </div>

          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: "#7A0B16", marginBottom: 4 }}>Confirmation</div>
            <input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={resetAll ? "NUKE ALL" : "NUKE"}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: 8,
                border: "1px solid #F3B1B8",
                fontSize: 12,
                fontWeight: 700,
                color: "#7A0B16",
                outline: "none",
              }}
            />
            <div style={{ marginTop: 6, fontSize: 11, color: "#7A0B16" }}>{hint}</div>
          </div>

          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <button
              onClick={runReset}
              disabled={status === "working"}
              style={{
                padding: "10px 12px",
                borderRadius: 9,
                border: "none",
                background: status === "working" ? "#D5D8DF" : "#C73D4D",
                color: "#fff",
                fontWeight: 900,
                fontSize: 12,
                cursor: status === "working" ? "not-allowed" : "pointer",
              }}
            >
              {status === "working" ? "Resetting..." : "Reset now"}
            </button>
          </div>
        </div>

        {error ? (
          <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 10, border: "1px solid #F3B1B8", background: "#fff", color: "#C73D4D", fontSize: 12, fontWeight: 700 }}>
            {error}
          </div>
        ) : null}

        {result?.ok ? (
          <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 10, border: "1px solid #B7E4D2", background: "#E4F6EE", color: "#1A8F62", fontSize: 12, fontWeight: 800 }}>
            Reset complete. Deleted <span style={{ fontWeight: 900 }}>{result.deletedEvaluations}</span> evaluations and cleared{" "}
            <span style={{ fontWeight: 900 }}>{result.clearedAssignments}</span> assignments.
          </div>
        ) : null}
      </div>

      <div style={{ border: "1px solid #F3B1B8", background: "#FDE9EB", borderRadius: 10, padding: 14 }}>
        <div style={{ fontWeight: 900, marginBottom: 6, color: "#7A0B16" }}>Danger zone: delete benchmark</div>
        <div style={{ fontSize: 12, color: "#7A0B16", lineHeight: 1.5 }}>
          Permanently deletes <b>all</b> database rows for a benchmark (evaluations, assignments, model mapping, benchmark state). This cannot be undone.
        </div>

        <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: "#7A0B16", marginBottom: 4 }}>Benchmark</div>
            <select
              value={benchmarkId}
              onChange={(e) => setBenchmarkId(e.target.value)}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: 8,
                border: "1px solid #F3B1B8",
                fontSize: 12,
                fontWeight: 700,
                background: "#fff",
                color: "#7A0B16",
                cursor: "pointer",
              }}
            >
              {benchmarkIds.length ? benchmarkIds.map((id) => <option key={id} value={id}>{id}</option>) : <option value="">(none)</option>}
            </select>
          </div>

          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: "#7A0B16", marginBottom: 4 }}>Confirmation</div>
            <input
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              placeholder={benchmarkId ? `DELETE ${benchmarkId}` : "DELETE"}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: 8,
                border: "1px solid #F3B1B8",
                fontSize: 12,
                fontWeight: 700,
                color: "#7A0B16",
                outline: "none",
              }}
            />
            <div style={{ marginTop: 6, fontSize: 11, color: "#7A0B16" }}>{deleteHint}</div>
          </div>

          <div style={{ display: "flex", alignItems: "flex-end" }}>
            <button
              onClick={runDelete}
              disabled={deleteStatus === "working"}
              style={{
                padding: "10px 12px",
                borderRadius: 9,
                border: "none",
                background: deleteStatus === "working" ? "#D5D8DF" : "#7A0B16",
                color: "#fff",
                fontWeight: 900,
                fontSize: 12,
                cursor: deleteStatus === "working" ? "not-allowed" : "pointer",
              }}
            >
              {deleteStatus === "working" ? "Deleting..." : "Delete benchmark"}
            </button>
          </div>
        </div>

        {deleteError ? (
          <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 10, border: "1px solid #F3B1B8", background: "#fff", color: "#C73D4D", fontSize: 12, fontWeight: 700 }}>
            {deleteError}
          </div>
        ) : null}

        {deleteResult?.ok ? (
          <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 10, border: "1px solid #B7E4D2", background: "#E4F6EE", color: "#1A8F62", fontSize: 12, fontWeight: 800, lineHeight: 1.5 }}>
            Deleted benchmark <span style={{ fontWeight: 900 }}>{deleteResult.benchmarkId}</span>.
            <div style={{ marginTop: 6, fontSize: 12, fontWeight: 800 }}>
              Evaluations: <span style={{ fontWeight: 900 }}>{deleteResult.deletedEvaluations}</span>{" "}
              · Response slots: <span style={{ fontWeight: 900 }}>{deleteResult.deletedResponseSlots}</span>{" "}
              · Question slots: <span style={{ fontWeight: 900 }}>{deleteResult.deletedQuestionSlots}</span>{" "}
              · Model mappings: <span style={{ fontWeight: 900 }}>{deleteResult.deletedModelMappings}</span>{" "}
              · Benchmark state: <span style={{ fontWeight: 900 }}>{deleteResult.deletedBenchmarkState}</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

