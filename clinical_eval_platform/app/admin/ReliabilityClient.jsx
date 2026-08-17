"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

const REFRESH_INTERVAL_MS = 20_000;

function formatPercent(value) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function formatKappa(value) {
  return value == null ? "—" : value.toFixed(2);
}

export default function ReliabilityClient({ datasetId, initialReliability }) {
  const [reliability, setReliability] = useState(initialReliability);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setRefreshing(true);
    try {
      const query = new URLSearchParams({ datasetId });
      const response = await fetch(`/api/admin/metrics?${query}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || "Reliability metrics could not be refreshed.");
      setReliability(data.reliability);
      setUpdatedAt(data.generatedAt || new Date().toISOString());
      setError("");
    } catch (caught) {
      setError(caught?.message || "Reliability metrics could not be refreshed.");
    } finally {
      if (!quiet) setRefreshing(false);
    }
  }, [datasetId]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh({ quiet: true });
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const rows = useMemo(
    () => [...(reliability?.fields || [])].sort((left, right) => {
      if (left.kappa == null && right.kappa != null) return 1;
      if (left.kappa != null && right.kappa == null) return -1;
      if (left.kappa !== right.kappa) return (left.kappa ?? 0) - (right.kappa ?? 0);
      return (left.agreement ?? 0) - (right.agreement ?? 0);
    }),
    [reliability],
  );

  return (
    <section className="admin-card admin-card--full">
      <div className="admin-card__heading">
        <div><p className="eyebrow">Inter-rater reliability</p><h2>Agreement by codebook field</h2></div>
        <div className="admin-live-controls">
          <span><i />Live{updatedAt ? ` · ${new Date(updatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}` : ""}</span>
          <button className="button button--quiet button--compact" disabled={refreshing} onClick={() => refresh()}>{refreshing ? "Refreshing…" : "Refresh"}</button>
        </div>
      </div>

      <div className="reliability-summary" aria-live="polite">
        <div><span>Comparable query pairs</span><strong>{reliability?.comparableQueries || 0}</strong></div>
        <div><span>Exact agreement</span><strong>{formatPercent(reliability?.overallAgreement)}</strong></div>
        <div><span>Mean Cohen’s κ</span><strong>{formatKappa(reliability?.meanKappa)}</strong></div>
      </div>

      {error ? <p className="inline-error">{error}</p> : null}
      {reliability?.excludedForCodebookVersion ? (
        <p className="inline-warning">{reliability.excludedForCodebookVersion} completed pair(s) were excluded because both reviews were not saved under the active codebook version.</p>
      ) : null}

      <div className="admin-table-wrap reliability-table-wrap">
        <table className="admin-table reliability-table">
          <thead><tr><th>Field</th><th>Pairs</th><th>Exact agreement</th><th>Cohen’s κ</th></tr></thead>
          <tbody>
            {rows.map((field) => (
              <tr key={field.key}>
                <td><strong>{field.number}. {field.label}</strong><small>{field.key}{field.isDerived ? " · derived (excluded from summary)" : ""}</small></td>
                <td>{field.pairs}</td>
                <td>{formatPercent(field.agreement)}</td>
                <td>{field.kappa == null ? <span title={field.kappaStatus === "no_variation" ? "Kappa is undefined when both reviewers use only one category." : "No completed pairs yet."}>—</span> : field.kappa.toFixed(2)}</td>
              </tr>
            ))}
            {!rows.length ? <tr><td colSpan="4" className="table-empty">Complete both reviews of a query to begin calculating reliability.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <p className="admin-card__note">Calculated only from queries with two complete reviews under the active codebook. Exact agreement is pooled across independently annotated forced-choice fields; derived fields are displayed but excluded from both summary measures. Cohen’s κ is unweighted and adjusts each field for chance agreement. A dash means there are no comparable pairs or no category variation yet. Early estimates are unstable, so interpret them alongside the pair count.</p>
    </section>
  );
}
