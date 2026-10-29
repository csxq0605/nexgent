#!/usr/bin/env python3
"""Same-model comparison of executors on one task set: Nexgent solo, Nexgent team, Claude Code and
mini-SWE-agent, each run once per task, then graded. Resumable: every finished (batch, group) leaves a
`.done` marker under the work directory, and a second run skips it.

  compare.py verified --ids-file sets/verified-hard45.txt --work <dir> --allow-spend [options]
      SWE-bench Verified: batches of `--batch` tasks; the four groups of a batch run at the same time;
      graded by the official harness (`swebench`).
  compare.py harbor --tasks <harbor dataset dir> --ids-file sets/rebench-2026-07-pick20.txt --work <dir> --allow-spend [options]
      Harbor SWE-style tasks (e.g. SWE-rebench monthly sets, fetched with `harbor download`): one task at a
      time; the task is built with `harbor_tasks.py prepare`, skipped unless its gold patch passes its own
      verifier, and every group is graded with `harbor_tasks.py grade`.
  compare.py report --work <dir>
      Resolved table per task and group, and the spend per group.

Groups (`--groups`, default all four): `solo` and `team` run `run.mjs --organization solo|team`, `cc` runs
`run.mjs --agent claude-code`, `mini` runs `mini-extra swebench` with its `swebench.yaml` config and no network
in the task container. Every group gets the same model, per-task cost cap and wall-time limit.

Spending: the key comes from `NEXGENT_API_KEY` (mini gets it as `ANTHROPIC_API_KEY` in its environment only),
`--allow-spend` is required, and `--budget solo=6,team=12,...` caps each group's total in USD. When a run reports
that the API account is out of credit, the driver stops without marking that batch done, so the next run
redoes it. A lock file keeps a second driver off the same work directory.

Needs Docker, `pnpm build`, `pip install swebench` (verified) and `pip install mini-swe-agent` (group mini).
"""
import argparse
import concurrent.futures
import fcntl
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
HARBOR = os.path.join(HERE, 'harbor_tasks.py')
GROUPS = ['solo', 'team', 'cc', 'mini']
# Default model and prices (USD per million tokens: input, output, cache read, cache write), as in packages/llm.
MODEL = 'claude-sonnet-5-5'
PRICE = (2, 10, 0.1, 2.5)
OUT_OF_CREDIT = re.compile(r'credit balance is too low', re.I)


class OutOfCredit(Exception):
    pass


def sh(argv, **kw):
    return subprocess.run(argv, capture_output=True, text=True, **kw)


def log(work, message):
    print(message, flush=True)
    with open(os.path.join(work, 'driver.log'), 'a') as f:
        f.write(time.strftime('%Y-%m-%d %H:%M:%S ') + message + '\n')


def read_ids(path):
    return [line.strip() for line in open(path) if line.strip() and not line.startswith('#')]


def group_spent(work, group):
    """USD spent by a group so far: Claude Code's own figure, else token totals at PRICE; mini's own cost."""
    total = 0.0
    for f in glob.glob(os.path.join(work, '*', group, '*', 'usage.json')):
        u = json.load(open(f))
        if u.get('reportedUsd') is not None:
            total += u['reportedUsd']
        else:
            total += (u['inputTokens'] * PRICE[0] + u['outputTokens'] * PRICE[1] + u['cacheReadTokens'] * PRICE[2] + u['cacheWriteTokens'] * PRICE[3]) / 1e6
    if group == 'mini':
        for f in glob.glob(os.path.join(work, '*', 'mini', '*', '*.traj.json')):
            total += json.load(open(f)).get('info', {}).get('model_stats', {}).get('instance_cost', 0)
    return total


def out_of_credit(paths):
    for path in paths:
        for f in [path] if os.path.isfile(path) else glob.glob(os.path.join(path, '**', '*'), recursive=True):
            if os.path.isfile(f) and f.endswith(('.log', '.txt', '.jsonl', '.json')):
                try:
                    if OUT_OF_CREDIT.search(open(f, errors='replace').read()):
                        return True
                except OSError:
                    pass
    return False


def run_group(args, bdir, group, instances, mini_subset):
    """Run one group on the batch's instances; mark it done unless the account ran out of credit."""
    out = os.path.join(bdir, group)
    done = out + '.done'
    if os.path.exists(done):
        return
    shutil.rmtree(out, ignore_errors=True)
    left = max(args.budget.get(group, float('inf')) - group_spent(args.work, group), 0)
    if left <= 0:
        log(args.work, f'{os.path.basename(bdir)} {group}: budget used up, skipped')
        return
    log_path = os.path.join(bdir, f'{group}.log')
    if group == 'mini':
        env = {**os.environ, 'ANTHROPIC_API_KEY': os.environ.get('NEXGENT_API_KEY', '')}
        argv = ['mini-extra', 'swebench', *mini_subset, '-o', out, '-w', str(min(len(instances), 2)), '-m', f'anthropic/{MODEL}',
                '-c', 'swebench.yaml', '-c', f'agent.cost_limit={args.cost_cap}', '-c', f'agent.wall_time_limit_seconds={args.timeout_min * 60}',
                '-c', 'environment.run_args=["--rm","--network","none"]']
        timeout = args.timeout_min * 60 * len(instances) + 600
        r = subprocess.run(argv, cwd=bdir, env=env, capture_output=True, text=True, timeout=timeout)
    else:
        extra = ['--agent', 'claude-code'] if group == 'cc' else ['--organization', group, '--prompt', 'workflow']
        if group == 'cc' and args.claude_bin:
            extra += ['--claude-bin', args.claude_bin]
        if args.mirror and args.suite == 'verified':
            extra += ['--mirror', args.mirror]
        spend = ['--mode', 'real', '--cost-cap', str(args.cost_cap), '--budget', f'{left:.2f}', '--allow-spend'] if args.mode == 'real' else ['--mode', args.mode]
        argv = ['node', os.path.join(HERE, 'run.mjs'), '--instances', os.path.join(bdir, 'instances.jsonl'), '--out', out,
                '--label', group, '--timeout-min', str(args.timeout_min), *spend, *extra]
        r = subprocess.run(argv, cwd=REPO, capture_output=True, text=True)
    open(log_path, 'w').write(r.stdout + r.stderr)
    if out_of_credit([log_path, out]):
        raise OutOfCredit(f'{os.path.basename(bdir)} {group}')
    open(done, 'w').write('')


def run_groups(args, bdir, instances, mini_subset):
    with concurrent.futures.ThreadPoolExecutor(len(args.groups)) as pool:
        futures = [pool.submit(run_group, args, bdir, g, instances, mini_subset) for g in args.groups]
        errors = [f.exception() for f in futures if f.exception() is not None]
    if errors:
        raise errors[0]


def verified(args):
    ids = read_ids(args.ids_file)
    for start in range(0, len(ids), args.batch):
        batch = ids[start:start + args.batch]
        bdir = os.path.join(args.work, f'b{start // args.batch:02d}')
        os.makedirs(bdir, exist_ok=True)
        if all(os.path.exists(os.path.join(bdir, f'{g}.done')) and os.path.exists(os.path.join(bdir, f'{g}.graded')) for g in args.groups):
            continue
        inst = os.path.join(bdir, 'instances.jsonl')
        if not os.path.exists(inst):
            r = sh([sys.executable, os.path.join(HERE, 'export_instances.py'), '--ids', *batch, '--out', inst])
            if r.returncode != 0:
                raise RuntimeError(f'export: {r.stderr[-500:]}')
        images = [json.loads(line)['image'] for line in open(inst) if line.strip()]
        for image in images:
            if sh(['docker', 'image', 'inspect', image]).returncode != 0 and args.mirror:
                if sh(['docker', 'pull', '-q', f'{args.mirror}/{image}']).returncode == 0:
                    sh(['docker', 'tag', f'{args.mirror}/{image}', image])
        mini_subset = ['--subset', 'verified', '--split', 'test', '--filter', '^(' + '|'.join(re.escape(i) for i in batch) + ')$']
        run_groups(args, bdir, batch, mini_subset)
        for g in args.groups:
            graded = os.path.join(bdir, f'{g}.graded')
            preds = os.path.join(bdir, g, 'preds.json' if g == 'mini' else 'predictions.jsonl')
            if os.path.exists(graded) or not os.path.exists(preds):
                continue
            rid = f'{os.path.basename(args.work)}-{os.path.basename(bdir)}-{g}'
            sh([sys.executable, '-m', 'swebench.harness.run_evaluation', '-d', 'SWE-bench/SWE-bench_Verified', '-p', preds, '-id', rid, '--max_workers', '2'], cwd=bdir)
            reports = glob.glob(os.path.join(bdir, f'*.{rid}.json'))
            if reports:
                shutil.copy(reports[0], os.path.join(bdir, f'{g}.report.json'))
                open(graded, 'w').write('')
        if not args.keep_images:
            for image in images:
                sh(['docker', 'rmi', '-f', image] + ([f'{args.mirror}/{image}'] if args.mirror else []))
            sh(['docker', 'container', 'prune', '-f'])
            sh(['docker', 'image', 'prune', '-f'])
        log(args.work, f'{os.path.basename(bdir)} done | ' + ', '.join(f'{g} ${group_spent(args.work, g):.2f}' for g in args.groups))


def harbor(args):
    for task in read_ids(args.ids_file):
        bdir = os.path.join(args.work, task)
        os.makedirs(bdir, exist_ok=True)
        if os.path.exists(os.path.join(bdir, 'skipped')) or all(os.path.exists(os.path.join(bdir, f'{g}.graded')) for g in args.groups):
            continue
        inst = os.path.join(bdir, 'instances.jsonl')
        r = sh([sys.executable, HARBOR, 'prepare', '--tasks', args.tasks, '--ids', task, '--out', inst] + (['--mirror', args.mirror] if args.mirror else []))
        if r.returncode != 0:
            log(args.work, f'{task}: prepare failed, skipped: {r.stderr[-300:]}')
            open(os.path.join(bdir, 'skipped'), 'w').write('prepare failed')
            continue
        instance = json.loads(open(inst).readline())
        if not os.path.exists(os.path.join(bdir, 'gold.ok')):
            config = json.load(open(os.path.join(instance['task_dir'], 'tests', 'config.json')))
            gold = os.path.join(bdir, 'gold.jsonl')
            open(gold, 'w').write(json.dumps({'instance_id': task, 'model_patch': config['patch']}) + '\n')
            sh([sys.executable, HARBOR, 'grade', '--instances', inst, '--predictions', gold, '--report', os.path.join(bdir, 'gold.report.json')])
            if json.load(open(os.path.join(bdir, 'gold.report.json')))['resolved_instances'] != 1:
                log(args.work, f'{task}: gold patch does not pass its verifier, skipped')
                open(os.path.join(bdir, 'skipped'), 'w').write('gold patch failed')
                continue
            open(os.path.join(bdir, 'gold.ok'), 'w').write('')
        # mini-SWE-agent reads a local dataset directory: `<dir>/test.jsonl`.
        os.makedirs(os.path.join(bdir, 'ds'), exist_ok=True)
        shutil.copy(inst, os.path.join(bdir, 'ds', 'test.jsonl'))
        run_groups(args, bdir, [task], ['--subset', os.path.join(bdir, 'ds'), '--split', 'test'])
        results = {}
        for g in args.groups:
            preds = os.path.join(bdir, g, 'preds.json' if g == 'mini' else 'predictions.jsonl')
            report = os.path.join(bdir, f'{g}.report.json')
            if not os.path.exists(preds):
                results[g] = 'missing'
                continue
            if not os.path.exists(os.path.join(bdir, f'{g}.graded')):
                sh([sys.executable, HARBOR, 'grade', '--instances', inst, '--predictions', preds, '--report', report])
                open(os.path.join(bdir, f'{g}.graded'), 'w').write('')
            results[g] = json.load(open(report))['resolved_instances']
        if not args.keep_images:
            base = next(line.split()[1] for line in open(os.path.join(instance['task_dir'], 'environment', 'Dockerfile')) if line.startswith('FROM '))
            sh(['docker', 'rmi', '-f', instance['image'], base])
            sh(['docker', 'container', 'prune', '-f'])
            sh(['docker', 'image', 'prune', '-f'])
            sh(['docker', 'builder', 'prune', '-af'])
        log(args.work, f'{task}: ' + ' '.join(f'{g}={v}' for g, v in results.items()) + ' | ' + ', '.join(f'{g} ${group_spent(args.work, g):.2f}' for g in args.groups))


def report(args):
    rows = {}
    for f in sorted(glob.glob(os.path.join(args.work, '*', '*.report.json'))):
        g = os.path.basename(f)[:-len('.report.json')]
        if g not in GROUPS:
            continue
        r = json.load(open(f))
        for iid in r.get('resolved_ids', []):
            rows.setdefault(iid, {})[g] = 1
        for key in ('unresolved_ids', 'empty_patch_ids', 'error_ids'):
            for iid in r.get(key, []):
                rows.setdefault(iid, {}).setdefault(g, 0)
    seen = [g for g in GROUPS if any(g in row for row in rows.values())]
    complete = {iid: row for iid, row in rows.items() if all(g in row for g in seen)}
    print('task | ' + ' | '.join(GROUPS))
    for iid in sorted(rows):
        print(iid + ' | ' + ' | '.join(str(rows[iid].get(g, '-')) for g in GROUPS))
    print(f'graded in every group ({",".join(seen)}): {len(complete)} tasks; resolved there: ' + ', '.join(f'{g} {sum(r[g] for r in complete.values())}' for g in seen))
    print('spent: ' + ', '.join(f'{g} ${group_spent(args.work, g):.2f}' for g in GROUPS))


def parse_budget(text):
    budget = {}
    for part in filter(None, (text or '').split(',')):
        g, usd = part.split('=')
        if g not in GROUPS:
            raise SystemExit(f'--budget: unknown group {g}')
        budget[g] = float(usd)
    return budget


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='suite', required=True)
    for name in ('verified', 'harbor'):
        p = sub.add_parser(name)
        p.add_argument('--ids-file', required=True)
        p.add_argument('--work', required=True)
        p.add_argument('--groups', default=','.join(GROUPS))
        p.add_argument('--budget', help='per-group USD caps, e.g. solo=6,team=12,cc=7,mini=6')
        p.add_argument('--cost-cap', type=float, default=1.5, help='USD per task and group')
        p.add_argument('--timeout-min', type=int, default=40)
        p.add_argument('--claude-bin')
        p.add_argument('--keep-images', action='store_true')
        p.add_argument('--allow-spend', action='store_true')
        p.add_argument('--mode', default='real', choices=['real', 'scripted-gold'],
                       help='scripted-gold: free check of the whole path with a scripted model that applies the gold patch (groups solo and team only)')
        p.add_argument('--mirror', help='registry to pull the images through, e.g. mirror.gcr.io')
        if name == 'verified':
            p.add_argument('--batch', type=int, default=5)
        else:
            p.add_argument('--tasks', required=True, help='directory of the downloaded Harbor dataset')
    r = sub.add_parser('report')
    r.add_argument('--work', required=True)
    args = parser.parse_args()
    args.work = os.path.abspath(args.work)
    if args.suite == 'report':
        return report(args)
    args.groups = [g for g in args.groups.split(',') if g]
    if any(g not in GROUPS for g in args.groups):
        raise SystemExit(f'--groups: choose from {",".join(GROUPS)}')
    if args.mode == 'real':
        if not args.allow_spend:
            raise SystemExit('the runs call the paid API: pass --allow-spend to confirm')
        if not os.environ.get('NEXGENT_API_KEY'):
            raise SystemExit('NEXGENT_API_KEY must be set in the environment')
    elif any(g in ('cc', 'mini') for g in args.groups):
        raise SystemExit('--mode scripted-gold runs the groups solo and team only (--groups solo,team)')
    args.budget = parse_budget(args.budget)
    os.makedirs(args.work, exist_ok=True)
    lock = open(os.path.join(args.work, '.lock'), 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit(f'another driver is running on {args.work}')
    try:
        verified(args) if args.suite == 'verified' else harbor(args)
        log(args.work, 'all done')
    except OutOfCredit as error:
        log(args.work, f'stopped: the API account is out of credit ({error}); rerun the same command after topping up')
        sys.exit(3)


if __name__ == '__main__':
    main()
