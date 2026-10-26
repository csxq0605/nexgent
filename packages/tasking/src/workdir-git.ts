/**
 * A member's copy of a git project carries the repository too, so the
 * member can use git there as in the project (history, reflog, diff,
 * commits, branches), and what it does to the repository comes back with
 * its files.
 *
 * - The copy gets the project's `.git/` without `objects/`; its
 *   `objects/info/alternates` names the project's object store, so every
 *   object the project has is readable and new ones land in the copy.
 * - The repository's state is compared as refs (`for-each-ref`), `HEAD`
 *   (the branch it names, or the commit when detached) and the index (its
 *   entries, `ls-files -s`), against the state when the copy was last in
 *   sync, the same way as files: only the member changed one, it is
 *   applied to the project (new objects copied first; refs updated with the
 *   old value checked); both changed it differently, a conflict (the project
 *   keeps its own). A refresh brings the project's changes into the copy
 *   where the member left that part alone.
 * - Only a project whose `.git` is a directory, and only when `git` runs.
 *
 * Nothing here depends on the kind of task.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, cp, lstat, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import * as nodePath from 'node:path'
import type { WorkdirConflict } from '@nexgent/kernel'

/** The repository state compared between the copy and the project. */
export interface GitState {
  /** `ref:<name>` when `HEAD` names a branch, else the commit id (empty when there is none). */
  readonly head: string
  /** Every ref and the object it points to. */
  readonly refs: Readonly<Record<string, string>>
  /** sha256 of the index entries (`ls-files -s`). */
  readonly index: string
}

const GIT_TIMEOUT_MS = 60_000

/** The environment git runs with: no repository named from outside, no prompts. */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[name]
  return env
}

/** Run git in `dir`; `undefined` when it fails. */
function git(dir: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile('git', ['-C', dir, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 256 * 1024 * 1024,
      env: gitEnv(),
      windowsHide: true,
    }, (error, stdout) => resolve(error === null ? stdout : undefined))
  })
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory()
  } catch {
    return false
  }
}

/** The repository state of a work tree (`undefined` when git cannot read it). */
export async function gitState(dir: string): Promise<GitState | undefined> {
  const listed = await git(dir, ['for-each-ref', '--format=%(refname)%00%(objectname)'])
  if (listed === undefined) return undefined
  const refs: Record<string, string> = {}
  for (const line of listed.split('\n')) {
    const [name, id] = line.split('\0')
    if (name !== undefined && name !== '' && id !== undefined) refs[name] = id
  }
  const branch = (await git(dir, ['symbolic-ref', '-q', 'HEAD']))?.trim()
  const head = branch !== undefined && branch !== '' ? `ref:${branch}` : ((await git(dir, ['rev-parse', '--verify', '-q', 'HEAD']))?.trim() ?? '')
  const entries = await git(dir, ['ls-files', '-s', '-z'])
  if (entries === undefined) return undefined
  return { head, refs, index: createHash('sha256').update(entries).digest('hex') }
}

/** Copy every file below `from` that `to` lacks (objects are named by their content, so a present one is the same). */
async function copyMissing(from: string, to: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(from)
  } catch {
    return
  }
  // Pack data before its index, so a reader never finds an index without its pack.
  names.sort((a, b) => Number(b.endsWith('.pack')) - Number(a.endsWith('.pack')) || (a < b ? -1 : a > b ? 1 : 0))
  for (const name of names) {
    if (name === 'info') continue
    const source = nodePath.join(from, name)
    const target = nodePath.join(to, name)
    const info = await lstat(source).catch(() => undefined)
    if (info === undefined) continue
    if (info.isDirectory()) {
      await mkdir(target, { recursive: true })
      await copyMissing(source, target)
      continue
    }
    if (!info.isFile() || (await stat(target).catch(() => undefined)) !== undefined) continue
    const temp = `${target}.${process.pid}.tmp`
    await copyFile(source, temp)
    await rename(temp, target).catch(() => rm(temp, { force: true }))
  }
}

/** A work tree's `HEAD` set to `head` (a branch, or a commit, detached). */
async function setHead(dir: string, head: string): Promise<boolean> {
  if (head === '') return true
  return head.startsWith('ref:')
    ? (await git(dir, ['symbolic-ref', 'HEAD', head.slice(4)])) !== undefined
    : (await git(dir, ['update-ref', '--no-deref', '-m', 'nexgent: sync', 'HEAD', head])) !== undefined
}

/** Set ref `name` from `old` to `next` (`undefined`: absent), checking the old value. */
async function setRef(dir: string, name: string, next: string | undefined, old: string | undefined): Promise<boolean> {
  const args = next === undefined
    ? ['update-ref', '-m', 'nexgent: sync', '-d', name, ...(old === undefined ? [] : [old])]
    : ['update-ref', '-m', 'nexgent: sync', name, next, ...(old === undefined ? [] : [old])]
  return (await git(dir, args)) !== undefined
}

/** Replace `to`'s index with `from`'s entries (through a tree `from` writes, whose objects `to` must reach; fails while `from` has unmerged entries). */
async function copyIndex(from: string, to: string): Promise<boolean> {
  const tree = (await git(from, ['write-tree']))?.trim()
  if (tree === undefined || tree === '') return false
  return (await git(to, ['read-tree', tree])) !== undefined
}

/** The repository part of one member's copy. */
export class WorkdirGit {
  private constructor(private readonly project: string, private readonly copy: string) {}

  /**
   * Give a fresh copy the project's repository (`.git/` without its objects,
   * which it reads from the project). `undefined` when the project has no
   * `.git` directory or git cannot read it.
   */
  static async create(project: string, copy: string): Promise<{ readonly git: WorkdirGit; readonly state: GitState } | undefined> {
    const source = nodePath.join(project, '.git')
    if (!(await isDirectory(source))) return undefined
    const state = await gitState(project)
    if (state === undefined) return undefined
    const target = nodePath.join(copy, '.git')
    await cp(source, target, { recursive: true, verbatimSymlinks: true, filter: path => path !== nodePath.join(source, 'objects') })
    await mkdir(nodePath.join(target, 'objects', 'info'), { recursive: true })
    await writeFile(nodePath.join(target, 'objects', 'info', 'alternates'), `${nodePath.join(source, 'objects')}\n`)
    const own = await gitState(copy)
    if (own === undefined) {
      await rm(target, { recursive: true, force: true })
      return undefined
    }
    return { git: new WorkdirGit(project, copy), state: own }
  }

  /** The repository part of a copy made before (a resumed session), when it has one. */
  static async resume(project: string, copy: string): Promise<WorkdirGit | undefined> {
    return (await isDirectory(nodePath.join(copy, '.git'))) && (await isDirectory(nodePath.join(project, '.git'))) ? new WorkdirGit(project, copy) : undefined
  }

  /** Whether the copy's repository changed since `base`. */
  async changed(base: GitState): Promise<boolean> {
    const copy = await gitState(this.copy)
    return copy !== undefined && !sameState(copy, base)
  }

  /** Bring what the member did to the repository into the project; returns the new base and the conflicts. */
  async merge(base: GitState): Promise<{ readonly base: GitState; readonly applied: readonly string[]; readonly conflicts: readonly WorkdirConflict[] }> {
    const [copy, project] = await Promise.all([gitState(this.copy), gitState(this.project)])
    if (copy === undefined || project === undefined) return { base, applied: [], conflicts: [] }
    const applied: string[] = []
    const conflicts: WorkdirConflict[] = []
    if (sameState(copy, base)) return { base, applied, conflicts }
    // New objects first (the index's tree is written in the copy so it goes along); refs and the index only point to objects the project has.
    const indexTree = copy.index !== base.index ? (await git(this.copy, ['write-tree']))?.trim() : undefined
    await copyMissing(nodePath.join(this.copy, '.git', 'objects'), nodePath.join(this.project, '.git', 'objects'))
    let index = base.index
    if (copy.index !== base.index) {
      if (project.index === base.index && indexTree !== undefined && indexTree !== '' && (await git(this.project, ['read-tree', indexTree])) !== undefined) applied.push('.git/index')
      else if (project.index !== copy.index) conflicts.push({ path: '.git/index', kind: 'both-changed' })
      index = copy.index
    }
    const refs: Record<string, string> = { ...base.refs }
    for (const name of new Set([...Object.keys(base.refs), ...Object.keys(copy.refs)])) {
      const before = base.refs[name]
      const theirs = copy.refs[name]
      if (theirs === before) continue
      const ours = project.refs[name]
      if (ours === before) {
        if (await setRef(this.project, name, theirs, before)) applied.push(`.git/${name}`)
        else conflicts.push({ path: `.git/${name}`, kind: 'both-changed' })
      } else if (ours !== theirs) {
        conflicts.push({ path: `.git/${name}`, kind: theirs === undefined ? 'deleted-by-member' : ours === undefined ? 'deleted-in-project' : 'both-changed' })
      }
      // The copy counts as in sync with the member's value; a refresh gives it the project's where they differ.
      if (theirs === undefined) delete refs[name]
      else refs[name] = theirs
    }
    if (copy.head !== base.head) {
      if (project.head === base.head) {
        if (await setHead(this.project, copy.head)) applied.push('.git/HEAD')
        else conflicts.push({ path: '.git/HEAD', kind: 'both-changed' })
      } else if (project.head !== copy.head) {
        conflicts.push({ path: '.git/HEAD', kind: 'both-changed' })
      }
    }
    return { base: { head: copy.head, refs, index }, applied, conflicts }
  }

  /** Bring the project's repository changes into the copy where the member left that part alone; returns the new base. */
  async refresh(base: GitState): Promise<GitState> {
    const [copy, project] = await Promise.all([gitState(this.copy), gitState(this.project)])
    if (copy === undefined || project === undefined) return base
    const refs: Record<string, string> = { ...base.refs }
    for (const name of new Set([...Object.keys(base.refs), ...Object.keys(project.refs)])) {
      const before = base.refs[name]
      const ours = project.refs[name]
      if (ours === before || copy.refs[name] !== before) continue
      // The project's objects are the copy's alternates: nothing to copy.
      if (!(await setRef(this.copy, name, ours, before))) continue
      if (ours === undefined) delete refs[name]
      else refs[name] = ours
    }
    let head = base.head
    if (project.head !== base.head && copy.head === base.head && (await setHead(this.copy, project.head))) head = project.head
    let index = base.index
    if (project.index !== base.index && copy.index === base.index && (await copyIndex(this.project, this.copy))) {
      index = (await gitState(this.copy))?.index ?? base.index
    }
    return { head, refs, index }
  }
}

function sameState(a: GitState, b: GitState): boolean {
  if (a.head !== b.head || a.index !== b.index) return false
  const names = new Set([...Object.keys(a.refs), ...Object.keys(b.refs)])
  for (const name of names) if (a.refs[name] !== b.refs[name]) return false
  return true
}

/** Pure: a saved {@link GitState}, or `undefined` when it is not one. */
export function parseGitState(value: unknown): GitState | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { head, refs, index } = value as { head?: unknown; refs?: unknown; index?: unknown }
  if (typeof head !== 'string' || typeof index !== 'string' || typeof refs !== 'object' || refs === null) return undefined
  const out: Record<string, string> = {}
  for (const [name, id] of Object.entries(refs)) {
    if (typeof id !== 'string') return undefined
    out[name] = id
  }
  return { head, refs: out, index }
}
