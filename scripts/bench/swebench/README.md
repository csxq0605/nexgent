# SWE-bench runs

Scripts that run the Nexgent CLI on SWE-bench Verified instances inside the official evaluation images and grade the result with the official harness (`swebench`).

The harness is kept apart from Nexgent: it drives the CLI only through its usual interface (`nexgent run` / `nexgent resume --task`, the `--json` event stream, `.nexgent/config.json` and documented environment variables), and every benchmark-only behavior lives in this directory.

| Script | What it does |
| --- | --- |
| `export_instances.py` | Writes chosen instances (ids, a seeded sample, a difficulty band) as JSON lines. |
| `run.mjs` | For each instance: starts its evaluation image, runs `nexgent run` in `/testbed`, writes `predictions.jsonl` plus per-instance records, ledger and token totals. |
| `followups.mjs` | Follow-up policies of the harness: after a run, whether to send the session another user message (`--followup`). |
| `harbor_tasks.py` | Prepares Harbor SWE-style tasks (e.g. SWE-rebench monthly sets) as instances for `run.mjs` and grades predictions with each task's own verifier. |
| `compare.py` | Same-model comparison driver: Nexgent solo, Nexgent team, Claude Code and mini-SWE-agent on one task set (`verified` or `harbor`), graded, resumable, with per-group budgets; `report` prints the resolved table and spend. |
| `sets/` | Task id lists: `verified-hard45.txt` (every Verified task rated 1 hour or more), `rebench-2026-07-pick20.txt` (SWE-rebench 2026-07, 4 per language). |
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

`--followup run-reminder,auto-continue[:N]` plays the user after the run: `run-reminder` asks once to run a reproduction and the existing tests when the run changed code and ran nothing afterwards; `auto-continue` asks to keep working until the last reply contains `TASK_COMPLETE`, at most N times (default 3). Each follow-up is `nexgent resume <sessionId> --task <text>` in the same container; `usage.json` lists the ones sent. Off by default.

`--agent claude-code` runs Claude Code (`claude -p`) on the same task text, image, network and model instead of Nexgent, for a same-model comparison. Model and effort default to Nexgent's defaults (`claude-sonnet-5-5`, `medium`), and its web tools are turned off because web search runs on the API side. `--claude-bin` picks the executable (default: `claude` on `PATH`). Its cost comes from Claude Code's own `result` line (`usage.json` `reportedUsd`).

```sh
node scripts/bench/swebench/run.mjs --instances five.jsonl --out out-cc --mode real --agent claude-code --cost-cap 1 --allow-spend
```

Needs Docker. `--mirror <registry>` pulls the images through a mirror and tags them under their original names.

## Comparing executors

`compare.py` runs each group once per task with the same model, cost cap and time limit, then grades it. Finished (batch, group) pairs leave `.done` markers in the work directory, so the same command continues where it stopped. It stops by itself, without marking the batch done, when the API account is out of credit, and a lock keeps a second driver off the same work directory. `--mode scripted-gold --groups solo,team` checks the whole path for free.

```sh
export NEXGENT_API_KEY=<key>
python3 scripts/bench/swebench/compare.py verified --ids-file scripts/bench/swebench/sets/verified-hard45.txt \
  --work runs/hard45 --mirror mirror.gcr.io --budget solo=6,team=12,cc=7,mini=6 --allow-spend
harbor download ibragim-badertdinov/swe-rebench-07-2026@2026-07 -o rebench-07
python3 scripts/bench/swebench/compare.py harbor --tasks rebench-07/swe-rebench-07-2026 \
  --ids-file scripts/bench/swebench/sets/rebench-2026-07-pick20.txt --work runs/rebench07 \
  --mirror mirror.gcr.io --budget solo=4,team=8,cc=5,mini=4 --allow-spend
python3 scripts/bench/swebench/compare.py report --work runs/hard45
```
