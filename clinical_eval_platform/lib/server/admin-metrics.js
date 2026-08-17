import { calculateReliability } from "../reliability";
import { REQUIRED_REVIEWS_PER_QUERY } from "../study-config";
import { CODEBOOK_VERSION, TAXONOMY_FIELDS } from "../taxonomy";

export async function loadReliabilityStats(sql, datasetId) {
  const rows = await sql`
    SELECT
      slots.question_id,
      jsonb_agg(
        jsonb_build_object(
          'labels', annotations.labels,
          'codebookVersion', annotations.codebook_version
        )
        ORDER BY slots.slot
      ) AS reviews
    FROM question_review_slots slots
    JOIN annotations
      ON annotations.dataset_id = slots.benchmark_id
      AND annotations.question_id = slots.question_id
      AND annotations.rater_id = slots.rater_id
      AND annotations.is_complete
    WHERE slots.benchmark_id = ${datasetId}
      AND slots.slot < ${REQUIRED_REVIEWS_PER_QUERY}
      AND slots.rater_id IS NOT NULL
    GROUP BY slots.question_id
    HAVING COUNT(*) = ${REQUIRED_REVIEWS_PER_QUERY}
    ORDER BY slots.question_id
  `;

  return calculateReliability(
    rows,
    TAXONOMY_FIELDS,
    {
      codebookVersion: CODEBOOK_VERSION,
      raterCount: REQUIRED_REVIEWS_PER_QUERY,
    },
  );
}
