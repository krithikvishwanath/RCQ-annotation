import Link from "next/link";
import { getDataset } from "../../lib/server/dataset";
import { ensureSchema } from "../../lib/server/schema";
import { getSql } from "../../lib/server/db";
import { loadReliabilityStats } from "../../lib/server/admin-metrics";
import { REQUIRED_REVIEWS_PER_QUERY } from "../../lib/study-config";
import AssignmentManager from "./AssignmentManager";
import QueryInventory from "./QueryInventory";
import ReliabilityClient from "./ReliabilityClient";
import ResetClient from "./ResetClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminPage() {
  let dataset;
  let summary = { total_slots: 0, assigned_slots: 0, started: 0, complete: 0, annotators: 0 };
  let raters = [];
  let allRaters = [];
  let coverage = [];
  let queryInventory = [];
  let reliability = { raterCount: REQUIRED_REVIEWS_PER_QUERY, fullyReviewedQueries: 0, comparableQueries: 0, excludedForCodebookVersion: 0, overallAgreement: null, meanKappa: null, fields: [] };
  let error = "";

  try {
    dataset = await getDataset();
    await ensureSchema();
    const sql = getSql();
    const summaryRows = await sql`
      SELECT
        (SELECT COUNT(*)::int FROM question_review_slots WHERE benchmark_id = ${dataset.datasetId} AND slot < ${REQUIRED_REVIEWS_PER_QUERY}) AS total_slots,
        (SELECT COUNT(*)::int FROM question_review_slots WHERE benchmark_id = ${dataset.datasetId} AND slot < ${REQUIRED_REVIEWS_PER_QUERY} AND rater_id IS NOT NULL) AS assigned_slots,
        (SELECT COUNT(*)::int FROM annotations a WHERE a.dataset_id = ${dataset.datasetId} AND EXISTS (
          SELECT 1 FROM question_review_slots s
          WHERE s.benchmark_id = a.dataset_id AND s.question_id = a.question_id
            AND s.rater_id = a.rater_id AND s.slot < ${REQUIRED_REVIEWS_PER_QUERY}
        )) AS started,
        (SELECT COUNT(*)::int FROM annotations a WHERE a.dataset_id = ${dataset.datasetId} AND a.is_complete AND EXISTS (
          SELECT 1 FROM question_review_slots s
          WHERE s.benchmark_id = a.dataset_id AND s.question_id = a.question_id
            AND s.rater_id = a.rater_id AND s.slot < ${REQUIRED_REVIEWS_PER_QUERY}
        )) AS complete,
        (SELECT COUNT(DISTINCT a.rater_id)::int FROM annotations a WHERE a.dataset_id = ${dataset.datasetId} AND EXISTS (
          SELECT 1 FROM question_review_slots s
          WHERE s.benchmark_id = a.dataset_id AND s.question_id = a.question_id
            AND s.rater_id = a.rater_id AND s.slot < ${REQUIRED_REVIEWS_PER_QUERY}
        )) AS annotators
    `;
    summary = summaryRows[0] || summary;

    raters = await sql`
      SELECT
        r.id::text AS rater_id,
        r.name,
        COUNT(DISTINCT s.question_id)::int AS assigned,
        COUNT(DISTINCT a.question_id)::int AS started,
        COUNT(DISTINCT a.question_id) FILTER (WHERE a.is_complete)::int AS complete,
        MAX(a.updated_at) AS last_activity
      FROM raters r
      LEFT JOIN question_review_slots s
        ON s.rater_id = r.id AND s.benchmark_id = ${dataset.datasetId}
        AND s.slot < ${REQUIRED_REVIEWS_PER_QUERY}
      LEFT JOIN annotations a
        ON a.rater_id = r.id AND a.dataset_id = ${dataset.datasetId}
        AND a.question_id = s.question_id
      GROUP BY r.id, r.name
      HAVING COUNT(DISTINCT s.question_id) > 0 OR COUNT(DISTINCT a.question_id) > 0
      ORDER BY MAX(a.updated_at) DESC NULLS LAST, r.name ASC
    `;

    const perQueryCoverage = await sql`
      SELECT
        s.question_id,
        COUNT(*) FILTER (WHERE s.rater_id IS NOT NULL)::int AS assigned_reviews,
        COUNT(a.rater_id) FILTER (WHERE a.is_complete)::int AS completed_reviews
      FROM question_review_slots s
      LEFT JOIN annotations a
        ON a.dataset_id = s.benchmark_id
        AND a.question_id = s.question_id
        AND a.rater_id = s.rater_id
      WHERE s.benchmark_id = ${dataset.datasetId}
        AND s.slot < ${REQUIRED_REVIEWS_PER_QUERY}
      GROUP BY s.question_id
      ORDER BY s.question_id
    `;

    const coverageByQuestion = new Map(
      perQueryCoverage.map((row) => [String(row.question_id), row]),
    );
    queryInventory = dataset.questions.map((question, index) => {
      const status = coverageByQuestion.get(String(question.id));
      return {
        id: String(question.id),
        position: index + 1,
        question: String(question.question || ""),
        assignedReviews: status?.assigned_reviews || 0,
        completedReviews: status?.completed_reviews || 0,
      };
    });
    coverage = Array.from(
      { length: REQUIRED_REVIEWS_PER_QUERY + 1 },
      (_, completedReviews) => ({
        completed_reviews: completedReviews,
        queries: queryInventory.filter(
          (query) => query.completedReviews === completedReviews,
        ).length,
      }),
    );

    allRaters = await sql`
      SELECT id::text AS rater_id, name
      FROM raters
      ORDER BY lower(name), created_at
    `;

    reliability = await loadReliabilityStats(sql, dataset.datasetId);
  } catch (caught) {
    error = caught?.message || "Administrative data could not be loaded.";
  }

  const totalQueries = dataset?.questions?.length || 0;
  const completionPercent = summary.total_slots
    ? Math.round((summary.complete / summary.total_slots) * 100)
    : 0;

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div className="brand-lockup"><span className="brand-mark">NYU</span><div><strong>Study administration</strong><span>Clinical Query Taxonomy</span></div></div>
        <div className="admin-header__actions">
          <Link className="button button--secondary button--compact" href="/">Annotator portal</Link>
          {dataset ? <a className="button button--primary button--compact" href={`/api/admin/export?datasetId=${encodeURIComponent(dataset.datasetId)}`}>Export CSV</a> : null}
        </div>
      </header>

      <div className="admin-content">
        <div className="admin-title">
          <div><p className="eyebrow">Operations</p><h1>Annotation study overview</h1><p>Monitor coverage, live agreement, reviewer progress, and assignment operations.</p></div>
          {dataset ? <div className="dataset-chip"><span>{dataset.isExample ? "Example data" : "Active dataset"}</span><strong>{dataset.datasetId}</strong><small>{totalQueries} queries · {dataset.skippedEmptyRows || 0} empty rows skipped · codebook {dataset.codebookVersion}</small></div> : null}
        </div>

        {error ? <div className="admin-error"><strong>Setup required</strong><span>{error}</span></div> : null}

        {!error && dataset ? (
          <>
            {dataset.isExample ? <div className="admin-warning"><strong>Example dataset is active.</strong> Do not begin data collection until the approved private dataset is connected.</div> : null}
            <section className="admin-stats" aria-label="Study statistics">
              <div><span>Queries</span><strong>{totalQueries}</strong><small>in active dataset</small></div>
              <div><span>Annotators</span><strong>{summary.annotators}</strong><small>with saved work</small></div>
              <div><span>Assigned slots</span><strong>{summary.assigned_slots}<em> / {summary.total_slots}</em></strong><small>{REQUIRED_REVIEWS_PER_QUERY} reviews per query</small></div>
              <div><span>Completed reviews</span><strong>{summary.complete}<em> / {summary.total_slots}</em></strong><small>{completionPercent}% complete</small></div>
            </section>

            <div className="admin-grid">
              <section className="admin-card admin-card--wide">
                <div className="admin-card__heading"><div><p className="eyebrow">Annotators</p><h2>Progress by reviewer</h2></div><span>{raters.length} active</span></div>
                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <thead><tr><th>Annotator</th><th>Assigned</th><th>Started</th><th>Complete</th><th>Last activity</th></tr></thead>
                    <tbody>
                      {raters.map((rater) => (
                        <tr key={rater.rater_id}>
                          <td><strong>{rater.name}</strong><small>{rater.rater_id.slice(0, 8)}</small></td>
                          <td>{rater.assigned}</td><td>{rater.started}</td><td><span className="table-complete">{rater.complete}</span></td>
                          <td>{rater.last_activity ? new Date(rater.last_activity).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" }) : "Not started"}</td>
                        </tr>
                      ))}
                      {!raters.length ? <tr><td colSpan="5" className="table-empty">No annotators have been assigned yet.</td></tr> : null}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="admin-card">
                <div className="admin-card__heading"><div><p className="eyebrow">Reliability</p><h2>Query coverage</h2></div></div>
                <div className="coverage-list">
                  {Array.from({ length: REQUIRED_REVIEWS_PER_QUERY + 1 }, (_, reviewCount) => reviewCount).map((reviewCount) => {
                    const found = coverage.find((row) => row.completed_reviews === reviewCount);
                    const count = found?.queries || 0;
                    return <div key={reviewCount}><span>{reviewCount} completed {reviewCount === 1 ? "review" : "reviews"}</span><strong>{count}</strong><div><i style={{ width: totalQueries ? `${(count / totalQueries) * 100}%` : "0%" }} /></div></div>;
                  })}
                </div>
                <p className="admin-card__note">Each query has {REQUIRED_REVIEWS_PER_QUERY} independent review slots. Export includes partial rows but marks completion explicitly.</p>
              </section>
            </div>

            <QueryInventory
              queries={queryInventory}
              requiredReviews={REQUIRED_REVIEWS_PER_QUERY}
            />

            <ReliabilityClient datasetId={dataset.datasetId} initialReliability={reliability} />

            <AssignmentManager datasetId={dataset.datasetId} raters={allRaters} />

            <section className="admin-card danger-card">
              <div className="admin-card__heading"><div><p className="eyebrow">Danger zone</p><h2>Reset active dataset</h2></div></div>
              <ResetClient datasetId={dataset.datasetId} />
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}
