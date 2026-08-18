import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { CODEBOOK_VERSION, TAXONOMY_FIELDS } from "../lib/taxonomy.js";

const schemaPath = new URL("../../llm_eval/annotation_schema.json", import.meta.url);
const compactPromptPath = new URL("../../llm_eval/prompt_compact.txt", import.meta.url);
const promptContractPath = new URL("../../llm_eval/prompt_contract.json", import.meta.url);
const canonicalPromptPath = new URL("../../prompt.txt", import.meta.url);

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

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

test("compact model prompt stays pinned to the canonical clinician codebook", () => {
  const canonical = fs.readFileSync(canonicalPromptPath, "utf8");
  const compact = fs.readFileSync(compactPromptPath, "utf8");
  const contract = JSON.parse(fs.readFileSync(promptContractPath, "utf8"));

  assert.equal(contract.schema_version, CODEBOOK_VERSION);
  assert.match(compact, new RegExp(contract.model_prompt_edition.replaceAll(".", "\\.")));
  assert.equal(sha256(canonical), contract.canonical_prompt_sha256);
  assert.equal(sha256(compact), contract.compact_prompt_sha256);
  assert.ok(compact.trim().split(/\s+/).length < canonical.trim().split(/\s+/).length * 0.7);

  for (const field of TAXONOMY_FIELDS) {
    assert.ok(compact.includes(field.key), `compact prompt is missing ${field.key}`);
    for (const option of field.options) {
      if (typeof option.value === "string") {
        assert.ok(compact.includes(option.value), `compact prompt is missing ${option.value}`);
      }
    }
  }

  const ids = new Set();
  for (const rule of contract.required_rules) {
    assert.ok(!ids.has(rule.id), `duplicate prompt rule id: ${rule.id}`);
    ids.add(rule.id);
    assert.ok(canonical.includes(rule.canonical_anchor), `canonical rule drift: ${rule.id}`);
    assert.ok(compact.includes(rule.compact_anchor), `compact rule drift: ${rule.id}`);
  }
  assert.ok(ids.size >= 20);
});
