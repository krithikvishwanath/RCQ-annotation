import test from "node:test";
import assert from "node:assert/strict";
import { calculateReliability } from "../lib/reliability.js";

const fields = [
  { key: "domain", number: "1", label: "Domain" },
  { key: "flag", number: "2", label: "Flag" },
];

test("reliability reports exact agreement and unweighted Cohen kappa", () => {
  const pairs = [
    { leftLabels: { domain: "yes", flag: 1 }, rightLabels: { domain: "yes", flag: 1 } },
    { leftLabels: { domain: "yes", flag: 1 }, rightLabels: { domain: "no", flag: 1 } },
    { leftLabels: { domain: "no", flag: 1 }, rightLabels: { domain: "no", flag: 1 } },
    { leftLabels: { domain: "no", flag: 1 }, rightLabels: { domain: "no", flag: 1 } },
  ];

  const result = calculateReliability(pairs, fields);
  assert.equal(result.pairedQueries, 4);
  assert.equal(result.overallAgreement, 0.875);
  assert.equal(result.fields[0].agreement, 0.75);
  assert.equal(result.fields[0].kappa, 0.5);
  assert.equal(result.fields[1].agreement, 1);
  assert.equal(result.fields[1].kappa, null);
  assert.equal(result.fields[1].kappaStatus, "no_variation");
});

test("reliability excludes pairs not completed under the active codebook", () => {
  const pairs = [
    {
      leftLabels: { domain: "Medicine", flag: 1 },
      rightLabels: { domain: "Medicine", flag: 1 },
      leftCodebookVersion: "v2.1",
      rightCodebookVersion: "v2.1",
    },
    {
      leftLabels: { domain: "Medicine", flag: 1 },
      rightLabels: { domain: "Medicine", flag: 1 },
      leftCodebookVersion: "v2",
      rightCodebookVersion: "v2.1",
    },
  ];

  const result = calculateReliability(pairs, fields, { codebookVersion: "v2.1" });
  assert.equal(result.pairedQueries, 2);
  assert.equal(result.comparableQueries, 1);
  assert.equal(result.excludedForCodebookVersion, 1);
});

test("derived fields are shown but excluded from summary agreement", () => {
  const result = calculateReliability(
    [
      {
        leftLabels: { coded: "A", derived: 1 },
        rightLabels: { coded: "B", derived: 1 },
      },
    ],
    [
      { key: "coded", number: "1", label: "Coded" },
      { key: "derived", number: "2", label: "Derived", type: "derived" },
    ],
  );

  assert.equal(result.overallAgreement, 0);
  assert.equal(result.fields[1].agreement, 1);
  assert.equal(result.fields[1].isDerived, true);
});
