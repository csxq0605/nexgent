# SWE-bench runs

Scripts that run the Nexgent CLI on SWE-bench Verified instances inside the official evaluation images and grade the result with the official harness (`swebench`).

| Script | What it does |
| --- | --- |
| `export_instances.py` | Writes chosen instances (ids, a seeded sample, a difficulty band) as JSON lines. |
| `run.mjs` | For each instance: starts its evaluation image, runs `nexgent run` in `/testbed`, writes `predictions.jsonl` plus per-instance records, ledger and token totals. |
| `summarize.mjs` | Per-instance and total resolved count, cost at given prices, wall time, and patches that touch test files. |

Modes of `run.mjs`: `scripted-gold` and `scripted-empty` answer with a local scripted model (no key, no cost) and check the path end to end; `real` uses the configured model and needs a key in the environment plus `--allow-spend`.

```sh
pnpm build
pip install swebench
python scripts/bench/swebench/export_instances.py --sample 5 --seed 0 --out five.jsonl
node scripts/bench/swebench/run.mjs --instances five.jsonl --out out-gold --mode scripted-gold
python -m swebench.harness.run_evaluation -d SWE-bench/SWE-bench_Verified -p out-gold/predictions.jsonl -id check --max_workers 2
node scripts/bench/swebench/summarize.mjs --out out-gold --report nexgent-scripted-gold.check.json
```

`run.mjs --mode real` runs each task container on an internal network whose only way out is `api-proxy.mjs`, a proxy to the model API that holds the key (`--network host` turns this off). `--organization solo|team` fixes how the CLI organizes every task (`NEXGENT_FORCE_ORGANIZATION`).

`--agent claude-code` runs Claude Code (`claude -p`) on the same task text, image, network and model instead of Nexgent, for a same-model comparison. Model and effort default to Nexgent's defaults (`claude-sonnet-5-5`, `medium`), and its web tools are turned off because web search runs on the API side. `--claude-bin` picks the executable (default: `claude` on `PATH`). Its cost comes from Claude Code's own `result` line (`usage.json` `reportedUsd`).

```sh
node scripts/bench/swebench/run.mjs --instances five.jsonl --out out-cc --mode real --agent claude-code --cost-cap 1 --allow-spend
```

Needs Docker. `--mirror <registry>` pulls the images through a mirror and tags them under their original names.
