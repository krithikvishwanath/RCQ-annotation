import test from "node:test";
import assert from "node:assert/strict";
import {
  annotationProgress,
  applyDerivedRules,
  emptyAnnotation,
  TAXONOMY_FIELDS,
  TAXONOMY_KEYS,
  validateAnnotation,
} from "../lib/taxonomy.js";
import { parseCsv } from "../lib/csv.js";
import { parseAnnotationCsv } from "../lib/dataset-parser.js";

test("CSV parser preserves commas, quotes, and embedded newlines", () => {
  const rows = parseCsv('id,text\r\n1,"Dose, route, and \"\"timing\"\"?"\r\n2,"line one\nline two"\r\n');
  assert.deepEqual(rows, [
    ["id", "text"],
    ["1", 'Dose, route, and "timing"?'],
    ["2", "line one\nline two"],
  ]);
});

test("dataset ingestion treats source metadata as metadata and skips only empty queries", () => {
  const parsed = parseAnnotationCsv(
    "row_index,phipii,text,specialty\n1,PHINO,First query,Medicine\n2,PHIYES,Second query,\n3,,,\n",
  );
  assert.equal(parsed.skippedEmptyRows, 1);
  assert.deepEqual(parsed.questions, [
    { id: "1", question: "First query", specialty: "Medicine" },
    { id: "2", question: "Second query", specialty: "" },
  ]);
});

test("dataset ingestion rejects duplicate stable IDs", () => {
  assert.throws(
    () => parseAnnotationCsv("row_index,text\n7,First\n7,Second\n"),
    /Duplicate query ID/,
  );
});

test("codebook exposes exactly 25 unique fields", () => {
  assert.equal(TAXONOMY_FIELDS.length, 25);
  assert.equal(new Set(TAXONOMY_KEYS).size, 25);
});

test("hard context rules are derived consistently", () => {
  const labels = applyDerivedRules({
    ...emptyAnnotation(),
    evidence_dependent: 0,
    ctx_patient: 0,
    ctx_institutional: 0,
    ctx_evidence: 1,
  });
  assert.equal(labels.evidence_dependent, 1);
  assert.equal(labels.needs_context, 1);
});

test("medicine division follows department conditional", () => {
  const surgery = applyDerivedRules({
    ...emptyAnnotation(),
    clinical_domain: "Surgery",
    medicine_division: "Cardiology",
  });
  assert.equal(surgery.medicine_division, "Not applicable");

  const medicine = applyDerivedRules({
    ...surgery,
    clinical_domain: "Medicine",
  });
  assert.equal(medicine.medicine_division, null);
});

test("server validation rejects extra keys and invalid values", () => {
  const extra = validateAnnotation({ ...emptyAnnotation(), unexpected: 1 });
  assert.equal(extra.ok, false);
  assert.match(extra.errors.join(" "), /Unexpected fields/);

  const invalid = validateAnnotation({ ...emptyAnnotation(), risk: "Very high" });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join(" "), /Invalid value for risk/);
});

test("a complete annotation has all 25 fields", () => {
  const labels = Object.fromEntries(
    TAXONOMY_FIELDS.map((field) => [field.key, field.options[0].value]),
  );
  labels.clinical_domain = "Medicine";
  labels.medicine_division = "Cardiology";
  labels.ctx_patient = 0;
  labels.ctx_institutional = 0;
  labels.ctx_evidence = 0;
  labels.needs_context = 0;
  const validated = validateAnnotation(labels, { partial: false });
  assert.equal(validated.ok, true, validated.errors.join(" "));
  assert.deepEqual(annotationProgress(validated.annotation), {
    completed: 25,
    total: 25,
    isComplete: true,
  });
});
