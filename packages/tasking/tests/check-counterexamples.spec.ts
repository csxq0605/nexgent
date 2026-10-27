/**
 * Counterexamples to the completion checks: ways a run could look checked
 * without the work being right. Each one the checks reject is a test; the
 * ones they do not reject yet are listed as `it.todo` with what would be
 * needed, so the list stays in one place.
 */
import { describe, expect, it } from 'vitest'
import { exitCodeMasked, LocalTaskRecorder, testCommandRan } from '../src/index.js'
import { project, SESSION_A } from './helpers.js'

const TASK = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
const NOW = () => new Date('2026-10-27T00:00:00.000Z')

describe('completion check counterexamples', () => {
  it('does not count a test run whose exit code is not the runner\'s', () => {
    for (const command of [
      'npm test || true',
      'npm test || exit 0',
      'pytest -q; echo done',
      'pytest -q | tail -5',
      'npx vitest run 2>&1 | tee test.log',
      'npm test |& cat',
      'pytest &',
      'pytest -q\necho ok',
    ]) {
      expect(exitCodeMasked(command), command).toBe(true)
      expect(testCommandRan(command, 0), command).toBe(false)
    }
  })

  it('does not count a run that passes with no tests', () => {
    expect(testCommandRan('npx vitest run --passWithNoTests', 0)).toBe(false)
    expect(testCommandRan('npx jest --pass-with-no-tests', 0)).toBe(false)
    expect(testCommandRan('python -m pytest -k nothing', 5)).toBe(false)
  })

  it('still counts honest runs: redirects, && chains and quoted filters keep the runner\'s code', () => {
    for (const command of ['npm test 2>&1', 'pnpm test > out.log 2>&1', 'npm test &> out.log', 'npm test && echo ok', 'pytest -k "parse or load|save"', "npx vitest run -t 'a; b'"]) {
      expect(exitCodeMasked(command), command).toBe(false)
      expect(testCommandRan(command, 1), command).toBe(true)
    }
  })

  it('keeps a failing honest run as a failing check when a masked run comes after it', async () => {
    const p = await project()
    const recorder = new LocalTaskRecorder(p.workspace.layout, { now: NOW })
    const { specs, results } = await recorder.end({
      taskId: TASK,
      sessionId: SESSION_A,
      deliverableFiles: [],
      commands: [
        { command: 'npm test', shell: 'bash', exitCode: 1 },
        { command: 'npm test || true', shell: 'bash', exitCode: 0 },
        { command: 'npm test | tail -3', shell: 'bash', exitCode: 0 },
      ],
    })
    expect(specs).toEqual([{ id: 'test-1', name: 'test-command', command: 'npm test', shell: 'bash' }])
    expect(results.map(result => [result.target, result.passed])).toEqual([['test-1', false]])
  })

  it('gives no passing test check for a masked run alone or for printed success', async () => {
    const p = await project()
    const recorder = new LocalTaskRecorder(p.workspace.layout, { now: NOW })
    const { specs } = await recorder.end({
      taskId: TASK,
      sessionId: SESSION_A,
      deliverableFiles: [],
      commands: [
        { command: 'pytest -q | tail -1', shell: 'bash', exitCode: 0 },
        { command: 'echo "42 passed"', shell: 'bash', exitCode: 0 },
      ],
    })
    expect(specs).toEqual([])
  })

  it('rejects missing and malformed deliverables', async () => {
    const p = await project()
    await p.write('report.json', '{"status": "ok", ')
    await p.write('table.csv', 'a,b\n1\n')
    await p.write('book.xlsx', 'PK fake')
    const recorder = new LocalTaskRecorder(p.workspace.layout, { now: NOW })
    const { results } = await recorder.end({
      taskId: TASK,
      sessionId: SESSION_A,
      deliverableFiles: ['report.json', 'table.csv', 'book.xlsx', 'missing.md'],
      commands: [],
    })
    expect(results.filter(result => !result.passed).map(result => [result.target, result.detail])).toEqual([
      ['parse-1', 'invalid JSON'],
      ['parse-2', 'row 2 has 1 fields, expected 2'],
      ['parse-3', 'not an xlsx workbook'],
      ['file-4', 'missing'],
    ])
  })

  it.todo('tests the model edited or deleted in this turn, then ran (needs a signal for test files changed in the turn, or checks kept where the model cannot write)')
  it.todo('a task where the model ran no tests at all (only the project check commands cover it)')
  it.todo('a narrowed run such as `pytest tests/test_one.py` or `vitest -t name` (passes for the part it ran)')
  it.todo('a project check command whose script lives in the project copy and was edited by the model')
  it.todo('an empty deliverable file (passes `file-exists`; only JSON, CSV and XLSX are parsed)')
})
