"""Write SWE-bench instances as JSON lines for run.mjs.

Usage:
  python scripts/bench/swebench/export_instances.py --out <file> [--dataset SWE-bench/SWE-bench_Verified]
      [--ids id1 id2 ...] [--sample N --seed S] [--difficulty "<15 min fix"]

Needs the `datasets` package (installed with `pip install swebench`). Each
line keeps the fields run.mjs uses: instance_id, repo, base_commit, image,
problem_statement, difficulty, and the gold `patch` (only the scripted
self-check replays it; the agent never sees it).
"""
import argparse
import json
import random

from datasets import load_dataset

FIELDS = ["instance_id", "repo", "base_commit", "image", "problem_statement", "difficulty", "patch"]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", default="SWE-bench/SWE-bench_Verified")
    parser.add_argument("--split", default="test")
    parser.add_argument("--ids", nargs="*")
    parser.add_argument("--sample", type=int)
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--difficulty")
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    rows = list(load_dataset(args.dataset, split=args.split))
    if args.ids:
        wanted = set(args.ids)
        rows = [row for row in rows if row["instance_id"] in wanted]
    if args.difficulty:
        rows = [row for row in rows if row.get("difficulty") == args.difficulty]
    rows.sort(key=lambda row: row["instance_id"])
    if args.sample is not None:
        rows = random.Random(args.seed).sample(rows, min(args.sample, len(rows)))
        rows.sort(key=lambda row: row["instance_id"])
    with open(args.out, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps({key: row.get(key) for key in FIELDS}, ensure_ascii=False) + "\n")
    print(f"wrote {len(rows)} instances to {args.out}")


if __name__ == "__main__":
    main()
