import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx");

function normHeader(h) {
  return String(h || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

const projectRoot = process.cwd();
const preferredSrcPath = path.join(projectRoot, "query_responses.csv");
const legacySrcPath = path.join(projectRoot, "query_responses.xlsx");
const srcPath = fs.existsSync(preferredSrcPath)
  ? preferredSrcPath
  : fs.existsSync(legacySrcPath)
    ? legacySrcPath
    : preferredSrcPath;
const outDir = path.join(projectRoot, "public");
const outPath = path.join(outDir, "benchmark.json");
const mapDir = path.join(projectRoot, "data");
const mapPath = path.join(mapDir, "model_map.json");
const questionsPath = path.join(mapDir, "benchmark_questions.json");

if (!fs.existsSync(srcPath)) {
  console.error(`Missing ${preferredSrcPath} (or legacy ${legacySrcPath})`);
  process.exit(1);
}

const srcBuf = fs.readFileSync(srcPath);
const benchmarkId = crypto
  .createHash("sha256")
  .update(srcBuf)
  .digest("hex")
  .slice(0, 16);

const ext = path.extname(srcPath).toLowerCase();
const wb =
  ext === ".csv"
    ? XLSX.read(srcBuf.toString("utf8").replace(/^\uFEFF/, ""), { type: "string" })
    : XLSX.read(srcBuf, { type: "buffer" });
if (!wb.SheetNames?.length) {
  console.error(`No sheets found in ${path.basename(srcPath)}`);
  process.exit(1);
}

const ws = wb.Sheets[wb.SheetNames[0]];
const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });
if (!aoa.length) {
  console.error("Empty sheet");
  process.exit(1);
}

const headerRow = aoa[0] || [];
const headers = headerRow.map((h) => String(h || "").trim());
const headersNorm = headers.map(normHeader);

const idCol = headersNorm.findIndex((h) =>
  ["index", "id", "query id", "query_id", "question id", "question_id"].includes(h),
);
const questionCol = headersNorm.findIndex((h) =>
  ["question", "query", "prompt"].includes(h),
);

if (questionCol === -1) {
  console.error(`Could not find a Question column. Headers: ${JSON.stringify(headers)}`);
  process.exit(1);
}

const responseCols = headers
  .map((h, i) => ({ key: h, i }))
  .filter(({ i, key }) => {
    if (i === questionCol) return false;
    if (i === idCol) return false;
    if (!String(key || "").trim()) return false;
    return true;
  });

const modelMap = responseCols.map((c, idx) => ({
  id: `Model_${String.fromCharCode(65 + idx)}`,
  name: String(c.key || "").trim(),
  colIndex: c.i,
}));

const questions = [];
for (let r = 1; r < aoa.length; r++) {
  const row = aoa[r] || [];
  const rawId = idCol >= 0 ? row[idCol] : r;
  const query = String(row[questionCol] || "").trim();
  if (!query) continue;

  const responses = modelMap
    .map((m) => ({
      key: m.id, // anonymized for rater blinding
      text: String(row[m.colIndex] || "").trim(),
    }))
    .filter((x) => x.text);

  if (!responses.length) continue;

  questions.push({
    id: String(rawId || "").trim() || `Q${String(questions.length + 1).padStart(3, "0")}`,
    query,
    responses,
  });
}

ensureDir(outDir);
ensureDir(mapDir);
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      benchmarkId,
      generatedAt: new Date().toISOString(),
      models: modelMap.map((m) => m.id),
      questions,
    },
    null,
    2,
  ),
);

fs.writeFileSync(
  mapPath,
  JSON.stringify(
    {
      benchmarkId,
      generatedAt: new Date().toISOString(),
      models: modelMap.map((m) => ({ id: m.id, name: m.name })),
    },
    null,
    2,
  ),
);

console.log(
  `Wrote ${path.relative(projectRoot, outPath)} (${questions.length} questions, ${modelMap.length} models, benchmarkId=${benchmarkId})`,
);
console.log(`Wrote ${path.relative(projectRoot, mapPath)} (admin-only model mapping)`);

fs.writeFileSync(
  questionsPath,
  JSON.stringify(
    {
      benchmarkId,
      generatedAt: new Date().toISOString(),
      questions: questions.map((q) => q.id),
    },
    null,
    2,
  ),
);
console.log(`Wrote ${path.relative(projectRoot, questionsPath)} (question index for sampling)`);

