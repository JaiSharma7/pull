#!/usr/bin/env python3
"""Triage public Delta candidate pairs without approving relationship edges.

Uses the 48 distinct product-owner labels as weak supervision. Predictions are
unverified proposals and must never be imported as approved relations.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
QUEUE = ROOT / "docs/eval/delta-review-queue.csv"
PILOT = ROOT / "docs/eval/delta-pilot-review.csv"
OUTPUT = ROOT / "docs/eval/delta-auto-proposals.csv"
STOP = set(
    "a an the and or but of to in on by for from as is are was were be being been "
    "with that this it its whose who when while than through into against their his "
    "her your our you they them he she we i".split()
)
LABELS = {
    "same claim": "S",
    "related but distinct": "R",
    "unrelated despite similar wording": "U",
}
FEATURE_SCALES = (0.65, 0.40, 0.60, 0.20, 0.35)


def rows(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8-sig") as stream:
        return list(csv.DictReader(stream))


def public_bodies() -> dict[str, str]:
    """Read only Pulls visible to the anonymous public role."""
    env = dict(
        line.split("=", 1)
        for line in (ROOT / "apps/web/.env.production").read_text().splitlines()
        if "=" in line and not line.startswith("#")
    )
    url = env["VITE_SUPABASE_URL"] + "/rest/v1/pulls?select=id,body&limit=1000"
    request = urllib.request.Request(
        url, headers={"apikey": env["VITE_SUPABASE_PUBLISHABLE_KEY"]}
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        data = json.load(response)
    return {item["id"]: item["body"] for item in data}


def tokens(value: str) -> set[str]:
    return {
        word
        for word in re.findall(r"[a-z0-9]+", value.lower())
        if word not in STOP
    }


def overlap(left: str, right: str) -> tuple[float, float]:
    a, b = tokens(left), tokens(right)
    if not a or not b:
        return 0.0, 0.0
    common = len(a & b)
    return common / len(a | b), common / min(len(a), len(b))


def features(row: dict[str, str], bodies: dict[str, str]) -> tuple[float, ...]:
    ids = row["known_pull_id"], row["candidate_pull_id"]
    if any(idea not in bodies for idea in ids):
        raise ValueError(f"Pair contains a Pull not publicly readable: {ids}")
    head_j, head_containment = overlap(row["known_headline"], row["candidate_headline"])
    body_j, body_containment = overlap(bodies[ids[0]], bodies[ids[1]])
    distance = max(0.0, float(row["cosine_distance"]))
    return (
        math.log1p(distance / 0.05),
        head_j,
        head_containment,
        body_j,
        body_containment,
    )


def feature_distance(a: tuple[float, ...], b: tuple[float, ...]) -> float:
    return math.sqrt(
        sum(((x - y) / scale) ** 2 for x, y, scale in zip(a, b, FEATURE_SCALES))
    )


def reviewed(queue: list[dict[str, str]], pilot: list[dict[str, str]]) -> list[dict[str, str]]:
    labeled = []
    seen = set()
    for source, source_rows in (("queue", queue), ("pilot", pilot)):
        for row in source_rows:
            key = tuple(sorted((row["known_pull_id"], row["candidate_pull_id"])))
            label = row["label"] if source == "queue" else row["reviewer_1_label"]
            if key in seen or label not in LABELS:
                continue
            seen.add(key)
            labeled.append({**row, "_source": source, "_label": LABELS[label]})
    return labeled


def proposal(
    item: dict[str, str],
    training: list[dict[str, str]],
    vectors: dict[tuple[str, str], tuple[float, ...]],
) -> tuple[str, float, str, str]:
    key = (item["known_pull_id"], item["candidate_pull_id"])
    neighbours = sorted(
        (
            feature_distance(vectors[key], vectors[(row["known_pull_id"], row["candidate_pull_id"])]),
            row.get("pair_id", row["known_pull_id"] + ":" + row["candidate_pull_id"]),
            row,
        )
        for row in training
    )[:5]
    votes: Counter[str] = Counter()
    for distance, _, row in neighbours:
        votes[row["_label"]] += 1 / max(0.05, distance)
    winner, vote = votes.most_common(1)[0]
    share = vote / sum(votes.values())
    nearest = neighbours[0][2]
    example = nearest.get("pair_id") or nearest["known_pull_id"] + ":" + nearest["candidate_pull_id"]
    # No reviewed C/E cases exist. The model cannot resolve either class.
    # Mark even strong S suggestions as unverified; no prediction is suppressible.
    label = winner if share >= 0.55 else "?"
    return label, share, nearest["_label"], example


def report_validation(
    training: list[dict[str, str]],
    vectors: dict[tuple[str, str], tuple[float, ...]],
) -> None:
    print("Reviewed pairs:", len(training), dict(Counter(row["_label"] for row in training)))
    for holdout in ("pilot", "queue"):
        test = [row for row in training if row["_source"] == holdout]
        fit = [row for row in training if row["_source"] != holdout]
        counts: Counter[tuple[str, str]] = Counter()
        for row in test:
            guess, _, _, _ = proposal(row, fit, vectors)
            counts[(row["_label"], guess)] += 1
        false_s = sum(n for (truth, guess), n in counts.items() if truth != "S" and guess == "S")
        print(
            f"Train on other 24; test {holdout} {len(test)}:",
            "agreement", sum(n for (truth, guess), n in counts.items() if truth == guess),
            "false-S", false_s,
            "confusion", dict(sorted(counts.items())),
        )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    queue, pilot = rows(QUEUE), rows(PILOT)
    bodies = public_bodies()
    training = reviewed(queue, pilot)
    if len(training) != 48:
        raise ValueError(f"Expected 48 distinct reviewed pairs; found {len(training)}")
    vectors = {
        (row["known_pull_id"], row["candidate_pull_id"]): features(row, bodies)
        for row in queue + training
    }
    report_validation(training, vectors)
    unresolved = [row for row in queue if not row["label"]]
    fieldnames = [
        "queue_index", "pair_id", "triage_bucket", "neighbor_vote_share",
        "nearest_reviewed_label", "nearest_reviewed_pair",
        "status", "can_suppress", "method", "pair_text_sha256",
    ]
    with args.output.open("w", newline="", encoding="utf-8") as stream:
        writer = csv.DictWriter(stream, fieldnames=fieldnames)
        writer.writeheader()
        for row in unresolved:
            label, share, nearest_label, example = proposal(row, training, vectors)
            bucket = {"S": "potential_overlap_needs_review", "R": "related_pattern", "U": "distant_pattern", "?": "ambiguous"}[label]
            pair_text = (
                row["known_headline"] + "\n" + bodies[row["known_pull_id"]] + "\n"
                + row["candidate_headline"] + "\n" + bodies[row["candidate_pull_id"]]
            )
            writer.writerow({
                "queue_index": row["queue_index"],
                "pair_id": row["pair_id"],
                "triage_bucket": bucket,
                "neighbor_vote_share": f"{share:.3f}",
                "nearest_reviewed_label": nearest_label,
                "nearest_reviewed_pair": example,
                "status": "unverified_auto_proposal",
                "can_suppress": "false",
                "method": "five_neighbor_lexical_vector_v1",
                "pair_text_sha256": hashlib.sha256(pair_text.encode()).hexdigest(),
            })
    result = rows(args.output)
    print("Unreviewed proposals:", len(result), dict(Counter(row["triage_bucket"] for row in result)))
    print("Wrote:", args.output)


if __name__ == "__main__":
    main()
