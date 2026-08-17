import { calculateReliability } from "../reliability";
import { CODEBOOK_VERSION, TAXONOMY_FIELDS } from "../taxonomy";

export async function loadReliabilityStats(sql, datasetId) {
  const rows = await sql`
    SELECT
      left_slot.question_id,
      left_annotation.labels AS left_labels,
      right_annotation.labels AS right_labels,
      left_annotation.codebook_version AS left_codebook_version,
      right_annotation.codebook_version AS right_codebook_version
    FROM question_review_slots left_slot
    JOIN question_review_slots right_slot
      ON right_slot.benchmark_id = left_slot.benchmark_id
      AND right_slot.question_id = left_slot.question_id
      AND right_slot.slot = 1
    JOIN annotations left_annotation
      ON left_annotation.dataset_id = left_slot.benchmark_id
      AND left_annotation.question_id = left_slot.question_id
      AND left_annotation.rater_id = left_slot.rater_id
      AND left_annotation.is_complete
    JOIN annotations right_annotation
      ON right_annotation.dataset_id = right_slot.benchmark_id
      AND right_annotation.question_id = right_slot.question_id
      AND right_annotation.rater_id = right_slot.rater_id
      AND right_annotation.is_complete
    WHERE left_slot.benchmark_id = ${datasetId}
      AND left_slot.slot = 0
      AND left_slot.rater_id IS NOT NULL
      AND right_slot.rater_id IS NOT NULL
    ORDER BY left_slot.question_id
  `;

  return calculateReliability(
    rows.map((row) => ({
      leftLabels: row.left_labels,
      rightLabels: row.right_labels,
      leftCodebookVersion: row.left_codebook_version,
      rightCodebookVersion: row.right_codebook_version,
    })),
    TAXONOMY_FIELDS,
    { codebookVersion: CODEBOOK_VERSION },
  );
}
