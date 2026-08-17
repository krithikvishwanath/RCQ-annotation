import { parseCsv } from "./csv.js";

function normalizeHeader(value) {
  return String(value || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export function parseAnnotationCsv(input) {
  const rows = parseCsv(input);
  if (rows.length < 2) throw new Error("The annotation dataset has no query rows.");

  const headers = (rows[0] || []).map(normalizeHeader);
  const findColumn = (accepted) => headers.findIndex((header) => accepted.includes(header));
  const idColumn = findColumn(["id", "index", "row_index", "query_id", "question_id", "chat_id"]);
  const questionColumn = findColumn([
    "question",
    "query",
    "prompt",
    "query_text",
    "chat",
    "message",
    "user_message",
    "text",
  ]);
  const specialtyColumn = findColumn([
    "specialty",
    "speciality",
    "asker_specialty",
    "clinician_specialty",
    "role",
  ]);
  if (questionColumn < 0) {
    throw new Error(
      `Could not find a question column. Expected question, query, prompt, query_text, or text; found ${headers.join(", ")}.`,
    );
  }

  const questions = [];
  const seenIds = new Set();
  let skippedEmptyRows = 0;
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    const question = String(row[questionColumn] || "").trim();
    if (!question) {
      skippedEmptyRows += 1;
      continue;
    }

    const fallbackId = `Q${String(questions.length + 1).padStart(4, "0")}`;
    const id = String(idColumn >= 0 ? row[idColumn] : fallbackId).trim() || fallbackId;
    if (seenIds.has(id)) throw new Error(`Duplicate query ID “${id}” at input row ${rowIndex + 1}.`);
    seenIds.add(id);
    questions.push({
      id,
      question,
      specialty: specialtyColumn >= 0 ? String(row[specialtyColumn] || "").trim() : "",
    });
  }
  if (!questions.length) throw new Error("The annotation dataset contains no usable queries.");
  return { questions, skippedEmptyRows };
}
