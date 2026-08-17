function categoryKey(value) {
  return `${typeof value}:${String(value)}`;
}

function fieldReliability(pairs, field) {
  const observations = pairs
    .map((pair) => [pair.leftLabels?.[field.key], pair.rightLabels?.[field.key]])
    .filter(([left, right]) => left != null && right != null);

  if (!observations.length) {
    return {
      key: field.key,
      number: field.number,
      label: field.label,
      pairs: 0,
      agreements: 0,
      agreement: null,
      kappa: null,
      kappaStatus: "no_pairs",
      isDerived: field.type === "derived",
    };
  }

  let agreements = 0;
  const leftCounts = new Map();
  const rightCounts = new Map();
  for (const [left, right] of observations) {
    const leftKey = categoryKey(left);
    const rightKey = categoryKey(right);
    if (leftKey === rightKey) agreements += 1;
    leftCounts.set(leftKey, (leftCounts.get(leftKey) || 0) + 1);
    rightCounts.set(rightKey, (rightCounts.get(rightKey) || 0) + 1);
  }

  const pairCount = observations.length;
  const agreement = agreements / pairCount;
  const categories = new Set([...leftCounts.keys(), ...rightCounts.keys()]);
  const expectedAgreement = [...categories].reduce(
    (sum, category) =>
      sum +
      ((leftCounts.get(category) || 0) / pairCount) *
        ((rightCounts.get(category) || 0) / pairCount),
    0,
  );
  const denominator = 1 - expectedAgreement;
  const kappa = Math.abs(denominator) < Number.EPSILON
    ? null
    : (agreement - expectedAgreement) / denominator;

  return {
    key: field.key,
    number: field.number,
    label: field.label,
    pairs: pairCount,
    agreements,
    agreement,
    kappa,
    kappaStatus: kappa == null ? "no_variation" : "available",
    isDerived: field.type === "derived",
  };
}

export function calculateReliability(pairs, fields, { codebookVersion } = {}) {
  const completedPairs = Array.isArray(pairs) ? pairs : [];
  const comparablePairs = codebookVersion
    ? completedPairs.filter(
        (pair) =>
          pair.leftCodebookVersion === codebookVersion &&
          pair.rightCodebookVersion === codebookVersion,
      )
    : completedPairs;
  const fieldStats = fields.map((field) => fieldReliability(comparablePairs, field));
  const observedFields = fieldStats.filter((field) => field.pairs > 0 && !field.isDerived);
  const kappaFields = observedFields.filter((field) => field.kappa != null);
  const totalDecisions = observedFields.reduce((sum, field) => sum + field.pairs, 0);
  const totalAgreements = observedFields.reduce((sum, field) => sum + field.agreements, 0);

  return {
    pairedQueries: completedPairs.length,
    comparableQueries: comparablePairs.length,
    excludedForCodebookVersion: completedPairs.length - comparablePairs.length,
    overallAgreement: totalDecisions ? totalAgreements / totalDecisions : null,
    meanKappa: kappaFields.length
      ? kappaFields.reduce((sum, field) => sum + field.kappa, 0) / kappaFields.length
      : null,
    fields: fieldStats,
  };
}
