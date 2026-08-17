import crypto from "node:crypto";
import bundledDataset from "../../data/annotation_set.json";
import { parseAnnotationCsv } from "../dataset-parser";

const MAX_DATASET_BYTES = 25 * 1024 * 1024;
let datasetPromise;

function parseDataset(buffer) {
  return parseAnnotationCsv(buffer.toString("utf8"));
}

function validatePrivateBlobUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ANNOTATION_BLOB_URL is not a valid URL.");
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".private.blob.vercel-storage.com")) {
    throw new Error("ANNOTATION_BLOB_URL must point to a Vercel Private Blob URL.");
  }
  return url;
}

async function loadPrivateDataset() {
  const blobUrl = validatePrivateBlobUrl(process.env.ANNOTATION_BLOB_URL);
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) throw new Error("BLOB_READ_WRITE_TOKEN is required for the private annotation dataset.");

  const response = await fetch(blobUrl, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("The private annotation dataset could not be retrieved.");
  const declaredSize = Number(response.headers.get("content-length") || 0);
  if (declaredSize > MAX_DATASET_BYTES) throw new Error("The private annotation dataset exceeds 25 MB.");
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_DATASET_BYTES) throw new Error("The private annotation dataset exceeds 25 MB.");

  const { questions, skippedEmptyRows } = parseDataset(buffer);
  const datasetId = crypto
    .createHash("sha256")
    .update(buffer)
    .update("clinician-query-codebook-v1")
    .digest("hex")
    .slice(0, 16);
  return {
    datasetId,
    generatedAt: new Date().toISOString(),
    codebookVersion: "v1",
    isExample: false,
    sourceLabel: "Private clinical query dataset",
    skippedEmptyRows,
    questions,
  };
}

export function getDataset() {
  if (!datasetPromise) {
    datasetPromise = (process.env.ANNOTATION_BLOB_URL
      ? loadPrivateDataset()
      : Promise.resolve(bundledDataset)
    ).catch((error) => {
      datasetPromise = undefined;
      throw error;
    });
  }
  return datasetPromise;
}
