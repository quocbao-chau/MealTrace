import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { markdown, validate } from './validate.mjs'
import { readTrx } from './trx.mjs'

const here = new URL('./', import.meta.url)
const original = JSON.parse(await readFile(new URL('mapping.json', here), 'utf8'))
const cli = fileURLToPath(new URL('validate.mjs', here))
const trx = await readFile(new URL('fixtures/SAMPLE-backend.trx', here), 'utf8')
const releaseSha = '1'.repeat(40)
const otherSha = '2'.repeat(40)
const binding = { version: 1, releaseSha, sample: true }
const digest = text => createHash('sha256').update(text).digest('hex')
const caseStatus = (report, id) => report.cases.find(row => row.id === id).status

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mealtrace-bm04-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const path = name => join(directory, name)
  const write = (name, value) => writeFile(path(name), typeof value === 'string' ? value : JSON.stringify(value))
  return { path, write, run: (options = {}) => validate({ releaseSha, sample: true, ...options }) }
}

async function addRun(ws, text, format, override = {}) {
  await ws.write('ci-results', text)
  await ws.write('provenance.json', { ...binding, job: 'backend', runId: 'SAMPLE-1', runAttempt: 1,
    format, source: 'SAMPLE test run', artifactSha256: digest(text), ...override })
  return { path: 'ci-results', provenance: 'provenance.json' }
}

async function completeEvidence(ws) {
  const mapping = structuredClone(original)
  const results = []
  const entries = []
  const log = 'SAMPLE synthetic execution log for validator tests\n'
  const references = [{ path: 'sample.log', sha256: digest(log) }]
  for (const row of mapping.cases) {
    if (row.ci) {
      row.mappingState = 'confirmed'
      row.tests = [{ job: 'backend', identity: `SAMPLE.${row.id}` }]
      results.push({ identity: row.tests[0].identity, status: 'PASSED' })
    } else {
      entries.push({ id: row.id, kind: row.evidenceSource, status: 'PASSED', environment: 'staging',
        device: 'SAMPLE Android handset', observedBy: 'SAMPLE observer', details: 'SAMPLE case', references })
    }
  }
  for (const row of mapping.demos) {
    entries.push({ id: row.id, kind: 'demo', status: 'PASSED', environment: 'staging',
      observedBy: 'SAMPLE observer', details: 'SAMPLE demo', references })
  }
  const defects = { ...binding, complete: true, reviewedBy: 'SAMPLE reviewer', defects: [], references }
  const options = { manifestPath: ws.path('manifest.json'), mappingPath: ws.path('mapping.json') }
  const save = async () => {
    const run = await addRun(ws, JSON.stringify({ version: 1, results }), 'ci-results-v1')
    await ws.write('manifest.json', { ...binding, runs: [run], observations: 'observations.json', runtimeDefects: 'defects.json' })
    await ws.write('mapping.json', mapping)
    await ws.write('observations.json', { ...binding, entries })
    await ws.write('defects.json', defects)
    await ws.write('sample.log', log)
  }
  await save()
  return { options, results, entries, defects, save }
}

test('official inventory preserves all workflow counts, CI designations and demos', async () => {
  const report = await validate({ releaseSha })
  assert.deepEqual(report.ledger, { unique: 30, ci: 24, ciPassed: 0, passed: 0, failed: 0, skipped: 0, executed: 0 })
  assert.deepEqual(Object.keys(report.openByOwner).sort(), ['Bảo', 'Cường', 'Hùng', 'Nam', 'Đạt'].sort())
  assert.deepEqual(Object.values(Object.groupBy(report.cases, row => row.workflow))
    .map(rows => [rows.length, rows.filter(row => row.ci).length]), [[5, 4], [5, 4], [4, 3], [4, 4], [6, 4], [6, 5]])
  assert.equal(report.demos.length, 12)
  assert.equal(report.decision, 'NO-GO')
  assert.equal(report.passRatePercent, null)
  assert.equal(caseStatus(report, 'W04-01'), 'MISSING')
  assert.equal(caseStatus(report, 'W01-01'), 'BLOCKED')
  assert.equal(caseStatus(report, 'W05-05'), 'MANUAL_DEVICE_REQUIRED')
})

test('rejects duplicate and missing inventory IDs', async t => {
  const ws = await workspace(t)
  const options = { mappingPath: ws.path('mapping.json') }
  const mapping = structuredClone(original)
  mapping.cases.push(mapping.cases[0])
  await ws.write('mapping.json', mapping)
  await assert.rejects(ws.run(options), /Duplicate case ID W01-01/)
  mapping.cases = original.cases.slice(1)
  await ws.write('mapping.json', mapping)
  await assert.rejects(ws.run(options), /Missing: W01-01/)
  mapping.cases = original.cases
  mapping.demos.pop()
  await ws.write('mapping.json', mapping)
  await assert.rejects(ws.run(options), /Missing: DS-06b/)
})

test('rejects fewer than 24 designated CI cases', async t => {
  const ws = await workspace(t)
  const mapping = structuredClone(original)
  mapping.cases[0].ci = false
  await ws.write('mapping.json', mapping)
  await assert.rejects(ws.run({ mappingPath: ws.path('mapping.json') }), /Fewer than 24/)
})

test('does not allow a mapping to remove a case from the main path', async t => {
  const ws = await workspace(t)
  const mapping = structuredClone(original)
  mapping.cases[0].mandatoryMainPath = false
  await ws.write('mapping.json', mapping)
  await assert.rejects(ws.run({ mappingPath: ws.path('mapping.json') }), /Missing mandatory main path designation for W01-01/)
})

test('TRX skips never pass even if the runner emits notExecuted=0', async () => {
  const report = await validate({ releaseSha, sample: true,
    manifestPath: fileURLToPath(new URL('fixtures/SAMPLE-manifest.json', here)) })
  assert.deepEqual(report.errors, [])
  assert.equal(caseStatus(report, 'W04-01'), 'SKIPPED')
  assert.equal(caseStatus(report, 'W04-02'), 'VERIFIED')
  assert.equal(report.ledger.passed, 1)
  assert.equal(report.ledger.executed, 1)
  assert.deepEqual(report.ciRuns[0].runnerResults, { PASSED: 2, FAILED: 0, SKIPPED: 1, BLOCKED: 0 })
})

test('repeated/parameterized records count only once and a failed row cannot be hidden', async t => {
  const ws = await workspace(t)
  const fixture = await completeEvidence(ws)
  const result = fixture.results[0]
  fixture.results.push({ ...result })
  await fixture.save()
  let report = await ws.run(fixture.options)
  assert.equal(report.ledger.ciPassed, 24)
  assert.equal(report.ciRuns[0].runnerResults.PASSED, 25)
  fixture.results.at(-1).status = 'FAILED'
  await fixture.save()
  report = await ws.run(fixture.options)
  assert.equal(caseStatus(report, 'W01-01'), 'FAILED')
  assert.equal(report.ledger.failed, 1)
  assert.equal(report.ledger.executed, 30)
})

test('rejects duplicate selected runs for the same CI job', async t => {
  const ws = await workspace(t)
  const run = await addRun(ws, trx, 'trx')
  await ws.write('manifest.json', { ...binding, runs: [run, run] })
  const report = await ws.run({ manifestPath: ws.path('manifest.json') })
  assert.match(report.errors.join(), /Multiple selected artifacts/)
  assert.equal(report.ledger.ciPassed, 0)
})

test('a candidate pass or an approximate test identity earns no case credit', async t => {
  const ws = await workspace(t)
  const unresolved = original.cases.find(row => row.id === 'W01-01')
  const confirmed = original.cases.find(row => row.id === 'W04-02')
  const results = [
    { identity: unresolved.tests[0].identity, status: 'PASSED' },
    { identity: confirmed.tests[0].identity + 'Suffix', status: 'PASSED' },
  ]
  const run = await addRun(ws, JSON.stringify({ version: 1, results }), 'ci-results-v1')
  await ws.write('manifest.json', { ...binding, runs: [run] })
  const report = await ws.run({ manifestPath: ws.path('manifest.json') })
  assert.deepEqual(report.errors, [])
  assert.equal(caseStatus(report, 'W01-01'), 'BLOCKED')
  assert.equal(caseStatus(report, 'W04-02'), 'MISSING')
  assert.equal(report.ledger.passed, 0)
})

test('rejects historical run SHA, invalid release SHA, and sample evidence in release mode', async t => {
  const ws = await workspace(t)
  const run = await addRun(ws, trx, 'trx', { releaseSha: otherSha })
  await ws.write('manifest.json', { ...binding, runs: [run] })
  const options = { manifestPath: ws.path('manifest.json') }
  const report = await ws.run(options)
  assert.match(report.errors.join(), /Release SHA mismatch/)
  assert.equal(report.ledger.ciPassed, 0)
  await assert.rejects(ws.run({ releaseSha: 'ce0ced2' }), /40-hex release SHA/)
  const release = await ws.run({ ...options, sample: false })
  assert.match(release.errors.join(), /sample marker/)
})

test('keeps missing manual, device and staging demo evidence open', async t => {
  const ws = await workspace(t)
  const fixture = await completeEvidence(ws)
  for (const id of ['W05-05', 'W03-04', 'DS-05a']) fixture.entries.splice(fixture.entries.findIndex(row => row.id === id), 1)
  await fixture.save()
  const report = await ws.run(fixture.options)
  assert.equal(caseStatus(report, 'W05-05'), 'MANUAL_DEVICE_REQUIRED')
  assert.equal(caseStatus(report, 'W03-04'), 'MANUAL_DEVICE_REQUIRED')
  assert.equal(report.demo.main, 5)
  assert.equal(report.gates.allCasesExecuted, false)
  assert.equal(report.decision, 'NO-GO')
})

test('rejects success observations without actual references, or with changed bytes', async t => {
  const ws = await workspace(t)
  const fixture = await completeEvidence(ws)
  fixture.entries.find(row => row.id === 'DS-05a').references = []
  await fixture.save()
  await ws.write('sample.log', 'different content')
  const report = await ws.run(fixture.options)
  assert.match(report.errors.join(), /DS-05a: Missing evidence references/)
  assert.match(report.errors.join(), /Evidence digest mismatch/)
  assert.equal(report.demo.main, 0)
  assert.equal(report.decision, 'NO-GO')
})

test('a failed mandatory case forces NO-GO even when the overall percentage passes', async t => {
  const ws = await workspace(t)
  const fixture = await completeEvidence(ws)
  fixture.entries.find(row => row.id === 'W05-05').status = 'FAILED'
  await fixture.save()
  const report = await ws.run(fixture.options)
  assert.equal(report.ledger.passed, 29)
  assert.equal(report.gates.ci, true)
  assert.equal(report.gates.overall, true)
  assert.equal(report.gates.mandatoryMainPaths, false)
  assert.equal(report.decision, 'NO-GO')
})

test('requires a complete defect disposition and rejects open Critical/High defects', async t => {
  const ws = await workspace(t)
  const fixture = await completeEvidence(ws)
  let manifest = JSON.parse(await readFile(fixture.options.manifestPath, 'utf8'))
  delete manifest.runtimeDefects
  await ws.write('manifest.json', manifest)
  let report = await ws.run(fixture.options)
  assert.equal(report.runtimeDefectStatus, 'BLOCKED')
  assert.equal(report.decision, 'NO-GO')

  fixture.defects.defects = [{ id: 'SAMPLE-RUNTIME', severity: 'HIGH', disposition: 'OPEN', details: 'SAMPLE only' }]
  await fixture.save()
  report = await ws.run(fixture.options)
  assert.equal(report.runtimeDefects.openHigh, 1)
  assert.equal(report.runtimeDefectStatus, 'FAILED')
  assert.equal(report.decision, 'NO-GO')
})

test('rejects missing and malformed input files and incorrect summary counts', async t => {
  const ws = await workspace(t)
  const options = { manifestPath: ws.path('manifest.json') }
  let report = await ws.run(options)
  assert.match(report.errors.join(), /ENOENT/)
  await ws.write('manifest.json', '{')
  report = await ws.run(options)
  assert.match(report.errors.join(), /Invalid JSON/)
  const run = await addRun(ws, '<TestRun>', 'trx')
  await ws.write('manifest.json', { ...binding, runs: [run], ledger: { passed: 30 }, demo: { main: 6 }, openCritical: 0 })
  report = await ws.run(options)
  assert.match(report.errors.join(), /Malformed or unsupported TRX XML/)
  assert.match(report.errors.join(), /Claimed ledger counts/)
  assert.match(report.errors.join(), /Claimed demo counts/)
  assert.match(report.errors.join(), /Claimed openCritical counts/)
  assert.equal(report.decision, 'NO-GO')
  assert.throws(() => readTrx(trx.replace('executed="2"', 'executed="3"')), /counter executed/)
  assert.throws(() => readTrx(trx.replace('total="3"', 'total="6"')), /counter total/)
  assert.throws(() => readTrx(trx.replace(' </Results>', ' </Wrong>')), /Unbalanced/)
  const failed = trx.replace('outcome="Passed"', 'outcome="Failed"').replace('passed="2" failed="0"', 'passed="1" failed="1"')
  assert.throws(() => readTrx(failed), /summary outcome contradicts/)
  assert.equal(readTrx(failed.replace('outcome="Completed"', 'outcome="Failed"'))[0].status, 'FAILED')
})

test('writes machine-readable and Markdown GO reports only for a complete synthetic pack', async t => {
  const ws = await workspace(t)
  const { options } = await completeEvidence(ws)
  const output = ws.path('output')
  const result = spawnSync(process.execPath, [cli, '--sha', releaseSha, '--sample',
    '--manifest', options.manifestPath, '--mapping', options.mappingPath, '--out', output], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const report = JSON.parse(await readFile(join(output, 'SAMPLE-bm04.json'), 'utf8'))
  assert.equal(report.sample, true)
  assert.equal(report.decision, 'GO')
  assert.deepEqual(report.ledger, { unique: 30, ci: 24, ciPassed: 24, passed: 30, failed: 0, skipped: 0, executed: 30 })
  const text = await readFile(join(output, 'SAMPLE-bm04.md'), 'utf8')
  assert.equal(text, markdown(report))
  assert.match(text, /^# SAMPLE/)
  assert.match(text, /Open evidence by owner and workflow/)
  assert.match(text, /Functional case and demo results/)
  assert.match(text, /Raw CI runner totals/)
})
