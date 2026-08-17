import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CODEBOOK_VERSION, TAXONOMY_FIELDS } from "../lib/taxonomy.js";

const schemaPath = new URL("../../llm_eval/annotation_schema.json", import.meta.url);

test("LLM evaluation schema stays identical to the clinician annotation schema", () => {
  const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  const expected = TAXONOMY_FIELDS.map((field) => ({
    key: field.key,
    type: field.type === "binary" || field.type === "derived" ? "integer" : "string",
    allowed: field.options.map((option) => option.value),
  }));

  assert.equal(schema.schema_version, CODEBOOK_VERSION);
  assert.deepEqual(schema.fields, expected);
});
