from __future__ import annotations

import json
import unittest
from pathlib import Path

from rcq_llm_eval.schema import (
    AnnotationSchema,
    AnnotationValidationError,
    parse_json_response,
)


ROOT = Path(__file__).resolve().parents[1]


class SchemaTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = AnnotationSchema.load(ROOT / "annotation_schema.json")

    def valid_annotation(self) -> dict[str, object]:
        annotation = {field.key: field.allowed[0] for field in self.schema.fields}
        annotation["medicine_division"] = "Not applicable"
        annotation["ctx_patient"] = 0
        annotation["ctx_institutional"] = 0
        annotation["ctx_evidence"] = 0
        annotation["needs_context"] = 0
        return annotation

    def test_schema_has_exactly_24_fields(self) -> None:
        self.assertEqual(len(self.schema.fields), 24)
        self.assertEqual(len(set(self.schema.keys)), 24)

    def test_json_schema_is_closed_and_requires_every_canonical_field(self) -> None:
        json_schema = self.schema.to_json_schema()
        self.assertFalse(json_schema["additionalProperties"])
        self.assertEqual(json_schema["required"], list(self.schema.keys))
        self.assertEqual(list(json_schema["properties"]), list(self.schema.keys))
        self.assertEqual(
            json_schema["properties"]["patient_specific"],
            {"type": "integer", "enum": [0, 1]},
        )

    def test_validation_preserves_canonical_field_order(self) -> None:
        annotation = self.valid_annotation()
        reversed_annotation = dict(reversed(list(annotation.items())))
        validated = self.schema.validate(reversed_annotation)
        self.assertEqual(tuple(validated), self.schema.keys)

    def test_validation_rejects_boolean_binary_and_extra_keys(self) -> None:
        annotation = self.valid_annotation()
        annotation["patient_specific"] = True
        annotation["explanation"] = "extra"
        with self.assertRaises(AnnotationValidationError) as caught:
            self.schema.validate(annotation)
        self.assertIn("patient_specific must be an integer", str(caught.exception))
        self.assertIn("Unexpected fields: explanation", str(caught.exception))

    def test_validation_enforces_hard_consistency_rules(self) -> None:
        annotation = self.valid_annotation()
        annotation["ctx_patient"] = 1
        annotation["needs_context"] = 0
        annotation["clinical_domain"] = "Medicine"
        with self.assertRaises(AnnotationValidationError) as caught:
            self.schema.validate(annotation)
        self.assertIn("needs_context", str(caught.exception))
        self.assertIn("named medicine_division", str(caught.exception))

    def test_response_parser_records_strict_fenced_and_extracted_modes(self) -> None:
        payload = self.valid_annotation()
        encoded = json.dumps(payload)
        self.assertEqual(parse_json_response(encoded), (payload, "strict"))
        self.assertEqual(parse_json_response(f"```json\n{encoded}\n```"), (payload, "fenced"))
        self.assertEqual(
            parse_json_response(f"Model preface\n{encoded}\ntrailing text"),
            (payload, "extracted"),
        )


if __name__ == "__main__":
    unittest.main()
