import { getDataset } from "../../../../lib/server/dataset";
import { getSql } from "../../../../lib/server/db";
import { loadLlmRunResults } from "../../../../lib/server/admin-metrics";
import { ensureSchema } from "../../../../lib/server/schema";
import {
  MAX_LLM_IMPORT_BYTES,
  parseJsonLines,
  validateLlmImport,
} from "../../../../lib/llm-evaluation";
import { json, publicError } from "../../../../lib/server/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fileFrom(form, key) {
  const value = form.get(key);
  if (!value || typeof value === "string" || typeof value.text !== "function") {
    throw new Error(`${key === "manifest" ? "Run manifest" : "Predictions"} file is required.`);
  }
  if (value.size > MAX_LLM_IMPORT_BYTES) {
    throw new Error(`${key === "manifest" ? "Run manifest" : "Predictions"} exceeds 4 MB.`);
  }
  return value;
}

export async function GET(request) {
  const datasetId = new URL(request.url).searchParams.get("datasetId");
  if (!datasetId) return json(400, { error: "datasetId is required." });

  try {
    const dataset = await getDataset();
    if (dataset.datasetId !== datasetId) {
      return json(404, { error: "The requested dataset is not active." });
    }
    await ensureSchema();
    return json(200, await loadLlmRunResults(getSql(), datasetId));
  } catch (error) {
    return publicError(error, "LLM annotations could not be loaded.");
  }
}

export async function POST(request) {
  let importValidated = false;
  try {
    const form = await request.formData();
    const manifestFile = fileFrom(form, "manifest");
    const predictionsFile = fileFrom(form, "predictions");
    const [manifestText, predictionsText] = await Promise.all([
      manifestFile.text(),
      predictionsFile.text(),
    ]);

    let manifest;
    try {
      manifest = JSON.parse(manifestText);
    } catch {
      return json(400, { error: "The run manifest is not valid JSON." });
    }

    const dataset = await getDataset();
    const validated = validateLlmImport({
      manifest,
      records: parseJsonLines(predictionsText),
      dataset,
    });
    importValidated = true;
    await ensureSchema();
    const sql = getSql();
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO llm_annotation_runs (
          run_id, dataset_id, provider, model, codebook_version,
          prompt_sha256, schema_sha256, record_count, manifest, updated_at
        ) VALUES (
          ${validated.run.runId}, ${validated.run.datasetId}, ${validated.run.provider},
          ${validated.run.model}, ${validated.run.codebookVersion},
          ${validated.run.promptSha256}, ${validated.run.schemaSha256},
          ${validated.run.recordCount}, ${transaction.json(validated.run.manifest)}, now()
        )
        ON CONFLICT (run_id) DO UPDATE SET
          dataset_id = EXCLUDED.dataset_id,
          provider = EXCLUDED.provider,
          model = EXCLUDED.model,
          codebook_version = EXCLUDED.codebook_version,
          prompt_sha256 = EXCLUDED.prompt_sha256,
          schema_sha256 = EXCLUDED.schema_sha256,
          record_count = EXCLUDED.record_count,
          manifest = EXCLUDED.manifest,
          imported_at = now(),
          updated_at = now()
      `;
      await transaction`
        DELETE FROM llm_annotations WHERE run_id = ${validated.run.runId}
      `;
      for (const record of validated.records) {
        await transaction`
          INSERT INTO llm_annotations (
            run_id, dataset_id, question_id, query_sha256,
            labels, attempts, usage, response_id
          ) VALUES (
            ${validated.run.runId}, ${validated.run.datasetId}, ${record.questionId},
            ${record.querySha256}, ${transaction.json(record.labels)}, ${record.attempts},
            ${transaction.json(record.usage)}, ${record.responseId}
          )
        `;
      }
    });

    return json(200, {
      ok: true,
      runId: validated.run.runId,
      provider: validated.run.provider,
      model: validated.run.model,
      imported: validated.records.length,
    });
  } catch (error) {
    if (!importValidated) {
      return json(400, { error: String(error?.message || "The import files are invalid.") });
    }
    return publicError(error, "The LLM run could not be imported.");
  }
}
