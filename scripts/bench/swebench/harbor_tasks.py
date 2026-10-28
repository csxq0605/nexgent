#!/usr/bin/env python3
"""Turn Harbor SWE-style tasks (e.g. `harbor download ibragim-badertdinov/swe-rebench-07-2026@2026-07`)
into the instance file `run.mjs` and mini-SWE-agent read, and grade predictions with each task's own verifier.

Each task directory holds `instruction.md` (the task text), `environment/Dockerfile` (the image),
`tests/test.sh` (the verifier, which writes `/logs/verifier/reward.txt`) and `tests/config.json`.

  prepare: build each chosen task's image as `nexgent-bench/<task>:harbor`, with `/testbed` linked to the
           repository so every agent works in `/testbed`; write JSON lines with `instance_id`, `repo`,
           `image`, `image_name` (the same, for mini-SWE-agent), `problem_statement` (instruction.md),
           `language`, `task_dir`, `patch` (the reference fix).
  grade:   for each prediction, start the task image, apply the patch in `/testbed`,
           run `tests/test.sh` and read the reward; write a report with `resolved_ids` like the
           SWE-bench harness.

  harbor_tasks.py prepare --tasks <dataset dir> --out <jsonl> [--per-language N --seed S | --ids ...] [--mirror <registry>]
  harbor_tasks.py grade --instances <jsonl> --predictions <predictions.jsonl|preds.json> --report <json>
"""
import argparse
import json
import os
import random
import shutil
import subprocess
import tempfile


def sh(argv, **kw):
    return subprocess.run(argv, capture_output=True, text=True, **kw)


def image_tag(task):
    return f"nexgent-bench/{task.lower()}:harbor"


def repo_dir(base_image):
    """The repository inside the image: its working directory, else the usual places."""
    workdir = sh(['docker', 'image', 'inspect', '-f', '{{.Config.WorkingDir}}', base_image]).stdout.strip()
    probe = ' '.join(d for d in [workdir, '/testbed', '/app', '/workspace', '/repo'] if d)
    found = sh(['docker', 'run', '--rm', '--entrypoint', 'sh', base_image, '-c',
                f'for d in {probe}; do if [ -d "$d/.git" ]; then echo "$d"; exit 0; fi; done; exit 1']).stdout.strip()
    if not found:
        raise RuntimeError(f'no repository found in {base_image}')
    return found


def pull(image, mirror):
    """Pull an image, through `mirror` (tagged back under its own name) when one is given."""
    if sh(['docker', 'image', 'inspect', image]).returncode == 0:
        return True
    if mirror:
        path = image.removeprefix('docker.io/')
        if sh(['docker', 'pull', '-q', f'{mirror}/{path}']).returncode == 0:
            return sh(['docker', 'tag', f'{mirror}/{path}', image]).returncode == 0
    return sh(['docker', 'pull', '-q', image]).returncode == 0


def build(task_dir, task, mirror=None):
    """The task's own Dockerfile plus a `/testbed` link to the repository and no entrypoint, so every runner
    can start it with its own command (built with network: it fetches `uv`)."""
    dockerfile = open(os.path.join(task_dir, 'environment', 'Dockerfile')).read()
    base = next(line.split()[1] for line in dockerfile.splitlines() if line.startswith('FROM '))
    if not pull(base, mirror):
        raise RuntimeError(f'cannot pull {base}')
    repo = repo_dir(base)
    link = '' if repo == '/testbed' else f'\nRUN ln -s {repo} /testbed\n'
    # The task's Dockerfile fetches `uv` with curl, which some images lack (`curl | sh` then fails quietly);
    # the verifier's log parser needs python3 or uv, so the host's `uv` is the fallback.
    uv = shutil.which('uv')
    fallback = '' if uv is None else '\nCOPY uv /usr/local/bin/uv-host\nRUN command -v uv >/dev/null 2>&1 || ln -s /usr/local/bin/uv-host /usr/local/bin/uv\n'
    with tempfile.TemporaryDirectory() as ctx:
        if uv is not None:
            shutil.copy(uv, os.path.join(ctx, 'uv'))
        open(os.path.join(ctx, 'Dockerfile'), 'w').write(dockerfile + fallback + link + '\nWORKDIR /testbed\nENTRYPOINT []\n')
        result = sh(['docker', 'build', '-q', '-t', image_tag(task), ctx])
        if result.returncode != 0:
            raise RuntimeError(f'build {task}: {result.stderr[-500:]}')
    return repo


def prepare(args):
    root = args.tasks
    tasks = sorted(t for t in os.listdir(root) if os.path.isdir(os.path.join(root, t)))
    configs = {t: json.load(open(os.path.join(root, t, 'tests', 'config.json'))) for t in tasks}
    if args.ids:
        chosen = [t for t in tasks if t in set(args.ids)]
    else:
        rng = random.Random(args.seed)
        by_language = {}
        for t in tasks:
            by_language.setdefault(configs[t].get('language', '?'), []).append(t)
        chosen = []
        for language in sorted(by_language):
            chosen += rng.sample(by_language[language], min(args.per_language, len(by_language[language])))
    with open(args.out, 'w') as out:
        for t in chosen:
            task_dir = os.path.join(root, t)
            repo = build(task_dir, t, args.mirror)
            out.write(json.dumps({
                'instance_id': t,
                'repo': configs[t]['repo'],
                'image': image_tag(t),
                'image_name': image_tag(t),
                'problem_statement': open(os.path.join(task_dir, 'instruction.md')).read(),
                'language': configs[t].get('language'),
                'repo_dir': repo,
                'task_dir': os.path.abspath(task_dir),
                # The reference fix, for the free scripted-gold check of run.mjs only; agents see only the problem statement.
                'patch': configs[t].get('patch', ''),
            }) + '\n')
            print(f'{t}: built {image_tag(t)} (repository at {repo})', flush=True)


def load_predictions(path):
    if path.endswith('.json'):
        return {k: v.get('model_patch') or '' for k, v in json.load(open(path)).items()}
    preds = {}
    for line in open(path):
        if line.strip():
            p = json.loads(line)
            preds[p['instance_id']] = p.get('model_patch') or ''
    return preds


def grade_one(instance, patch, timeout):
    """Apply the patch in a fresh container (default network: grading, no agent), run the task's verifier, read the reward."""
    name = f"nexgent-grade-{instance['instance_id'].lower()}-{os.getpid()}"
    sh(['docker', 'run', '-d', '--name', name, '--entrypoint', 'sleep', instance['image'], 'infinity'])
    try:
        # The verifier writes next to itself, so it gets a copy, not a read-only mount.
        sh(['docker', 'cp', f"{instance['task_dir']}/tests", f'{name}:/tests'])
        # Harbor creates the verifier's log directory before it runs the verifier.
        sh(['docker', 'exec', name, 'mkdir', '-p', '/logs/verifier'])
        if patch.strip():
            applied = sh(['docker', 'exec', '-i', '-w', '/testbed', name, 'git', 'apply', '--whitespace=nowarn', '-'], input=patch)
            if applied.returncode != 0:
                return 0, 'patch did not apply: ' + applied.stderr[-300:]
        run = sh(['docker', 'exec', '-w', instance['repo_dir'], name, 'bash', '/tests/test.sh'], timeout=timeout)
        reward = sh(['docker', 'exec', name, 'cat', '/logs/verifier/reward.txt']).stdout.strip()
        return (1 if reward == '1' else 0), run.stdout[-2000:]
    except subprocess.TimeoutExpired:
        return 0, 'verifier timed out'
    finally:
        sh(['docker', 'rm', '-f', name])


def grade(args):
    instances = [json.loads(line) for line in open(args.instances) if line.strip()]
    preds = load_predictions(args.predictions)
    report = {'resolved_ids': [], 'unresolved_ids': [], 'empty_patch_ids': [], 'missing_ids': [], 'notes': {}}
    for instance in instances:
        iid = instance['instance_id']
        if iid not in preds:
            report['missing_ids'].append(iid)
            continue
        if not preds[iid].strip():
            report['empty_patch_ids'].append(iid)
            continue
        reward, note = grade_one(instance, preds[iid], args.timeout)
        report['resolved_ids' if reward == 1 else 'unresolved_ids'].append(iid)
        report['notes'][iid] = note[-500:]
        print(f'{iid}: {"resolved" if reward else "unresolved"}', flush=True)
    report['resolved_instances'] = len(report['resolved_ids'])
    report['total_instances'] = len(instances)
    json.dump(report, open(args.report, 'w'), indent=2)
    print(f"resolved {report['resolved_instances']}/{len(instances)}")


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('prepare')
    p.add_argument('--tasks', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--per-language', type=int, default=4)
    p.add_argument('--seed', type=int, default=0)
    p.add_argument('--ids', nargs='*')
    p.add_argument('--mirror', help='registry to pull the base images through, e.g. mirror.gcr.io')
    g = sub.add_parser('grade')
    g.add_argument('--instances', required=True)
    g.add_argument('--predictions', required=True)
    g.add_argument('--report', required=True)
    g.add_argument('--timeout', type=int, default=3000)
    args = parser.parse_args()
    prepare(args) if args.cmd == 'prepare' else grade(args)


if __name__ == '__main__':
    main()
