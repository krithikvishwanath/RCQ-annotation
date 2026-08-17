import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseAnnotationCsv } from "../lib/dataset-parser.js";

const projectRoot = process.cwd();
const configuredInput = String(process.env.ANNOTATION_INPUT || "").trim();
const candidates = [
  configuredInput,
  "real_chats.csv",
  "real_chat_sample.csv",
  "../real_chats.csv",
  "../real_chat_sample.csv",
  "clinical_queries.csv",
  "queries.csv",
  "query_responses.csv",
]
  .filter(Boolean)
  .map((candidate) => (path.isAbsolute(candidate) ? candidate : path.join(projectRoot, candidate)));

let sourcePath = candidates.find((candidate) => fs.existsSync(candidate));
let isExample = false;
if (!sourcePath) {
  sourcePath = path.join(projectRoot, "examples", "queries.csv");
  isExample = true;
} else if (/sample/i.test(path.basename(sourcePath))) {
  isExample = true;
}

if (!fs.existsSync(sourcePath)) {
  console.error(
    "No annotation input found. Add real_chats.csv or clinical_queries.csv, or set ANNOTATION_INPUT.",
  );
  process.exit(1);
}

function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

const sourceBuffer = fs.readFileSync(sourcePath);
let parsed;
try {
  parsed = parseAnnotationCsv(sourceBuffer.toString("utf8"));
} catch (error) {
  console.error(error?.message || "The annotation dataset could not be parsed.");
  process.exit(1);
}
const { questions, skippedEmptyRows } = parsed;

const datasetId = crypto
  .createHash("sha256")
  .update(sourceBuffer)
  .update("clinician-query-codebook-v1")
  .digest("hex")
  .slice(0, 16);

const generatedAt = new Date().toISOString();
const dataDirectory = path.join(projectRoot, "data");
ensureDir(dataDirectory);

const codebookPath = [
  process.env.CODEBOOK_INPUT,
  path.join(projectRoot, "..", "prompt.txt"),
  path.join(projectRoot, "prompt.txt"),
]
  .filter(Boolean)
  .find((candidate) => fs.existsSync(candidate));
if (!codebookPath) {
  console.error("The verbatim codebook prompt.txt could not be found.");
  process.exit(1);
}
const codebookText = fs.readFileSync(codebookPath, "utf8").replace(/^\uFEFF/, "").trim();
if (!codebookText.includes("Clinician Query Annotation Codebook") || !codebookText.includes("Output format")) {
  console.error("prompt.txt does not appear to contain the Clinician Query Annotation Codebook.");
  process.exit(1);
}

fs.writeFileSync(
  path.join(dataDirectory, "annotation_set.json"),
  JSON.stringify(
    {
      datasetId,
      generatedAt,
      codebookVersion: "v1",
      isExample,
      sourceLabel: isExample ? "Example dataset" : path.basename(sourcePath),
      skippedEmptyRows,
      questions,
    },
    null,
    2,
  ),
);

fs.writeFileSync(
  path.join(dataDirectory, "codebook.json"),
  JSON.stringify(
    {
      version: "v1",
      sha256: crypto.createHash("sha256").update(codebookText).digest("hex"),
      text: codebookText,
    },
    null,
    2,
  ),
);

console.log(
  `Prepared ${questions.length} queries from ${isExample ? "the example dataset" : path.basename(sourcePath)}; skipped ${skippedEmptyRows} rows without query text (datasetId=${datasetId}).`,
);
