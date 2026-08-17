import test from "node:test";
import assert from "node:assert/strict";
import {
  ADDITIONAL_ASSIGNMENT_COUNT,
  INITIAL_ASSIGNMENT_COUNT,
  REQUIRED_REVIEWS_PER_QUERY,
} from "../lib/study-config.js";

test("study assignment policy remains fixed", () => {
  assert.equal(INITIAL_ASSIGNMENT_COUNT, 40);
  assert.equal(ADDITIONAL_ASSIGNMENT_COUNT, 10);
  assert.equal(REQUIRED_REVIEWS_PER_QUERY, 3);
});
