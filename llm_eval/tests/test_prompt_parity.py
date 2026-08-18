from __future__ import annotations

import hashlib
import json
import unittest
from pathlib import Path

from rcq_llm_eval.schema import AnnotationSchema


LLM_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = LLM_ROOT.parent


class PromptParityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = AnnotationSchema.load(LLM_ROOT / "annotation_schema.json")
        cls.canonical = (REPO_ROOT / "prompt.txt").read_text(encoding="utf-8")
        cls.compact = (LLM_ROOT / "prompt_compact.txt").read_text(encoding="utf-8")
        cls.contract = json.loads(
            (LLM_ROOT / "prompt_contract.json").read_text(encoding="utf-8")
        )

    def test_contract_hashes_require_intentional_review_of_prompt_changes(self) -> None:
        self.assertEqual(self.contract["schema_version"], self.schema.version)
        self.assertIn(self.contract["model_prompt_edition"], self.compact)
        self.assertEqual(
            hashlib.sha256(self.canonical.encode("utf-8")).hexdigest(),
            self.contract["canonical_prompt_sha256"],
        )
        self.assertEqual(
            hashlib.sha256(self.compact.encode("utf-8")).hexdigest(),
            self.contract["compact_prompt_sha256"],
        )

    def test_compact_prompt_contains_every_field_and_allowed_string_value(self) -> None:
        self.schema.validate_prompt_coverage(self.compact)

    def test_critical_semantic_rules_are_anchored_in_both_prompts(self) -> None:
        rule_ids: set[str] = set()
        for rule in self.contract["required_rules"]:
            self.assertNotIn(rule["id"], rule_ids)
            rule_ids.add(rule["id"])
            self.assertIn(rule["canonical_anchor"], self.canonical, rule["id"])
            self.assertIn(rule["compact_anchor"], self.compact, rule["id"])
        self.assertGreaterEqual(len(rule_ids), 20)

    def test_compact_prompt_is_materially_shorter_without_dropping_calibration_cases(self) -> None:
        self.assertLess(len(self.compact.split()), len(self.canonical.split()) * 0.70)
        self.assertEqual(self.compact.count("Question:  "), 3)  # input contract + two examples


if __name__ == "__main__":
    unittest.main()
