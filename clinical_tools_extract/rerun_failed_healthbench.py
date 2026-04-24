#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import pathlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

from evaluation_pipeline import _resolve_grader_target, score_criterion_panel


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Rerun only failed HealthBench panel criteria in scored.json files."
    )
    parser.add_argument(
        "--runs-root",
        type=pathlib.Path,
        default=pathlib.Path("data/runs"),
        help="Root directory containing per-model run outputs.",
    )
    parser.add_argument(
        "--models",
        nargs="+",
        required=True,
        help="Model IDs to patch in place (e.g., openevidence-web uptodate-ai).",
    )
    parser.add_argument(
        "--panel-models",
        required=True,
        help="Comma-separated panel model IDs in voting order.",
    )
    parser.add_argument(
        "--model-registry",
        type=pathlib.Path,
        default=pathlib.Path("data/runs/model_registry.json"),
        help="Model registry path used to resolve panel model endpoints.",
    )
    parser.add_argument(
        "--max-workers",
        type=int,
        default=4,
        help="Parallel workers for failed-criterion reruns.",
    )
    return parser


def _load_json(path: pathlib.Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as infile:
        return json.load(infile)


def _write_json(path: pathlib.Path, payload: dict[str, Any]) -> None:
    with path.open("w", encoding="utf-8") as outfile:
        json.dump(payload, outfile, ensure_ascii=False, indent=2)


def _conversation_from_row(row: dict[str, Any]) -> str:
    question = str(row.get("question", "")).strip()
    answer = str(row.get("answer", "")).strip()
    return f"user: {question}\n\nassistant: {answer}"


def _candidate_indices(rows: list[dict[str, Any]]) -> list[tuple[int, int]]:
    targets: list[tuple[int, int]] = []
    for row_i, row in enumerate(rows):
        rubric_scores = row.get("rubric_scores", [])
        if not isinstance(rubric_scores, list):
            continue
        for rub_i, scored in enumerate(rubric_scores):
            if not isinstance(scored, dict):
                continue
            vote_counts = scored.get("panel_vote_counts", {})
            failed = 0
            if isinstance(vote_counts, dict):
                try:
                    failed = int(vote_counts.get("failed", 0) or 0)
                except Exception:
                    failed = 0
            panel_failures = scored.get("panel_failures", [])
            has_failures = bool(panel_failures) if isinstance(panel_failures, list) else False
            if failed > 0 or has_failures:
                targets.append((row_i, rub_i))
    return targets


def _recompute_totals(rows: list[dict[str, Any]]) -> tuple[float, float]:
    grand_total = 0.0
    grand_possible = 0.0
    for row in rows:
        rubric_scores = row.get("rubric_scores", [])
        line_total = 0.0
        line_possible = 0.0
        if isinstance(rubric_scores, list):
            for scored in rubric_scores:
                if not isinstance(scored, dict):
                    continue
                points = float(scored.get("points", 0) or 0)
                earned = points if bool(scored.get("criteria_met", False)) else 0.0
                scored["points_awarded"] = earned
                line_total += earned
                if points > 0:
                    line_possible += points
        row["point_total"] = line_total
        row["point_possible"] = line_possible
        grand_total += line_total
        grand_possible += line_possible
    return grand_total, grand_possible


def _rerun_model(
    runs_root: pathlib.Path,
    model: str,
    grader_targets: list[dict[str, Any]],
    max_workers: int,
) -> dict[str, Any]:
    scored_path = runs_root / model / "healthbench" / "scored.json"
    if not scored_path.exists():
        raise FileNotFoundError(f"Missing scored file: {scored_path}")

    payload = _load_json(scored_path)
    rows = payload.get("rows", [])
    if not isinstance(rows, list):
        raise ValueError(f"Invalid rows payload in {scored_path}")

    old_score = float(payload.get("final_score", 0.0) or 0.0)
    targets = _candidate_indices(rows)
    if not targets:
        return {
            "model": model,
            "path": str(scored_path),
            "old_score": old_score,
            "new_score": old_score,
            "rerun_criteria": 0,
        }

    def task(row_i: int, rub_i: int) -> tuple[int, int, dict[str, Any]]:
        row = rows[row_i]
        rubric_scores = row.get("rubric_scores", [])
        scored = rubric_scores[rub_i]
        conversation = _conversation_from_row(row)
        rubric_item = {
            "criterion": scored.get("criterion", ""),
            "points": scored.get("points", 0),
            "tags": scored.get("tags", []),
        }
        new_score = score_criterion_panel(conversation, rubric_item, grader_targets)
        return row_i, rub_i, new_score

    with ThreadPoolExecutor(max_workers=max(1, max_workers)) as executor:
        futures = [executor.submit(task, row_i, rub_i) for row_i, rub_i in targets]
        for future in as_completed(futures):
            row_i, rub_i, new_score = future.result()
            rows[row_i]["rubric_scores"][rub_i] = new_score

    grand_total, grand_possible = _recompute_totals(rows)
    new_score = (grand_total / grand_possible) if grand_possible > 0 else 0.0
    payload["rows"] = rows
    payload["final_points_total"] = grand_total
    payload["final_points_possible"] = grand_possible
    payload["final_score"] = new_score
    payload["grading_strategy"] = "panel_majority"
    payload["grading_models"] = grader_targets
    _write_json(scored_path, payload)

    return {
        "model": model,
        "path": str(scored_path),
        "old_score": old_score,
        "new_score": new_score,
        "rerun_criteria": len(targets),
    }


def main() -> None:
    args = _build_parser().parse_args()
    panel_models = [item.strip() for item in args.panel_models.split(",") if item.strip()]
    if not panel_models:
        raise ValueError("--panel-models cannot be empty")

    grader_targets = [
        _resolve_grader_target(model=panel_model, model_registry=args.model_registry)
        for panel_model in panel_models
    ]

    summaries = []
    for model in args.models:
        summaries.append(
            _rerun_model(
                runs_root=args.runs_root,
                model=model,
                grader_targets=grader_targets,
                max_workers=args.max_workers,
            )
        )
    print(json.dumps(summaries, indent=2))


if __name__ == "__main__":
    main()
