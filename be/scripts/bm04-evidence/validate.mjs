import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { readTrx } from './trx.mjs'

const defaultMapping = fileURLToPath(new URL('./mapping.json', import.meta.url))
const workflows = [
  ['WF-01', 'Đạt', 5, 4, [1, 2, 4]],
  ['WF-02', 'Hùng', 5, 4, [1, 2, 3, 4, 5]],
  ['WF-03', 'Nam', 4, 3, [1, 2]],
  ['WF-04', 'Nam', 4, 4, [1, 3, 4]],
  ['WF-05', 'Cường', 6, 4, [1, 2, 5, 6]],
  ['WF-06', 'Bảo', 6, 5, [1, 2, 4, 5]],
]
const caseIds = new Map()
const demoIds = new Map()
for (const [workflow, owner, count, ciCount, mainStoryCases] of workflows) {
  const number = workflow.slice(3)
  for (let index = 1; index <= count; index++) {
    const id = `W${number}-${String(index).padStart(2, '0')}`
    caseIds.set(id, { workflow, owner, requiredInCi: index <= ciCount, mainPath: mainStoryCases.includes(index) })
  }
  demoIds.set(`DS-${number}a`, { workflow, owner, kind: 'main' })
  demoIds.set(`DS-${number}b`, { workflow, owner, kind: 'exception' })
}

const statuses = ['VERIFIED', 'MISSING', 'BLOCKED', 'FAILED', 'SKIPPED', 'MANUAL_DEVICE_REQUIRED']
const outcomes = new Set(['PASSED', 'FAILED', 'SKIPPED', 'BLOCKED'])
const shaPattern = /^(?!0{40}$)[a-f0-9]{40}$/
const isText = value => typeof value === 'string' && value.trim().length > 0
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const testKey = ({ job, identity }) => JSON.stringify([job, identity])
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function requireValid(condition, message) {
  if (!condition) throw new Error(message)
}

function checkFields(data, allowed, source) {
  const unexpected = Object.keys(data).filter(key => !allowed.includes(key))
  requireValid(unexpected.length === 0, `Unexpected fields in ${source}: ${unexpected.join(', ')}`)
}

function indexRows(rows, name) {
  requireValid(Array.isArray(rows), `Expected ${name} array`)
  const result = new Map()
  for (const row of rows) {
    requireValid(isObject(row) && isText(row.id), `Invalid ${name} ID`)
    requireValid(!result.has(row.id), `Duplicate ${name} ID ${row.id}`)
    result.set(row.id, row)
  }
  return result
}

function checkInventory(rows, expected, name) {
  const missing = [...expected.keys()].filter(id => !rows.has(id))
  const unexpected = [...rows.keys()].filter(id => !expected.has(id))
  requireValid(!missing.length && !unexpected.length,
    `Invalid ${name} inventory. Missing: ${missing.join(', ') || 'none'}. Unexpected: ${unexpected.join(', ') || 'none'}`)
}

function validateMapping(mapping) {
  requireValid(mapping?.version === 1, 'Expected mapping version 1')
  const cases = indexRows(mapping.cases, 'case')
  const demos = indexRows(mapping.demos, 'demo')
  checkInventory(cases, caseIds, 'case')
  checkInventory(demos, demoIds, 'demo')
  requireValid([...cases.values()].filter(row => row.ci === true).length >= 24,
    'Fewer than 24 CI-designated cases')

  for (const [id, expected] of caseIds) {
    const row = cases.get(id)
    checkFields(row, ['id', 'workflow', 'owner', 'description', 'requirements', 'mandatoryMainPath',
      'ci', 'evidenceSource', 'mappingState', 'tests'], id)
    const device = id === 'W05-05' || id === 'W05-06'
    requireValid(row.workflow === expected.workflow && row.owner === expected.owner &&
      isText(row.description) && isText(row.requirements) &&
      typeof row.mandatoryMainPath === 'boolean' && typeof row.ci === 'boolean',
    `Invalid case mapping for ${id}`)
    requireValid((!expected.requiredInCi || row.ci) &&
      row.evidenceSource === (device ? 'device' : row.ci ? 'ci' : 'manual'),
    `Invalid CI designation or evidence source for ${id}`)
    requireValid(!expected.mainPath || row.mandatoryMainPath, `Missing mandatory main path designation for ${id}`)
    requireValid(row.ci ? ['confirmed', 'unresolved'].includes(row.mappingState) : row.mappingState === 'manual',
      `Invalid mapping state for ${id}`)
    requireValid(Array.isArray(row.tests) && row.tests.every(test =>
      isObject(test) && isText(test.job) && isText(test.identity)), `Invalid test identities for ${id}`)
    for (const test of row.tests) checkFields(test, ['job', 'identity'], id)
    requireValid(new Set(row.tests.map(testKey)).size === row.tests.length &&
      (row.mappingState !== 'confirmed' || row.tests.length > 0), `Missing or duplicate test identities for ${id}`)
  }
  for (const [id, expected] of demoIds) {
    const row = demos.get(id)
    checkFields(row, ['id', 'kind', 'workflow', 'owner', 'description'], id)
    requireValid(Object.entries(expected).every(([key, value]) => row[key] === value) && isText(row.description),
      `Invalid demo mapping for ${id}`)
  }
  return { cases, demos }
}

async function readRelative(root, path) {
  requireValid(isText(path) && !isAbsolute(path) && !path.split(/[\\/]/).includes('..'),
    'Evidence paths must be relative to the manifest directory')
  const bytes = await readFile(resolve(root, path))
  requireValid(bytes.length > 0, `Empty evidence file ${path}`)
  return bytes
}

const utf8 = bytes => new TextDecoder('utf-8', { fatal: true }).decode(bytes)

function readJson(bytes, source) {
  try {
    return JSON.parse(utf8(bytes))
  } catch (error) {
    throw new Error(`Invalid JSON in ${source}`, { cause: error })
  }
}

function checkBinding(data, releaseSha, sample, source) {
  requireValid(data?.version === 1 && data.sample === sample, `Invalid version or sample marker in ${source}`)
  requireValid(data.releaseSha === releaseSha, `Release SHA mismatch in ${source}`)
}

async function readReferences(root, references) {
  requireValid(Array.isArray(references) && references.length > 0, 'Missing evidence references')
  for (const ref of references) {
    requireValid(isObject(ref) && /^[a-f0-9]{64}$/.test(ref.sha256), 'Invalid reference digest')
    requireValid(sha256(await readRelative(root, ref.path)) === ref.sha256, `Evidence digest mismatch for ${ref.path}`)
  }
  return references.map(({ path, sha256 }) => ({ path, sha256 }))
}

function readAdapter(bytes) {
  const data = readJson(bytes, 'CI adapter output')
  requireValid(data?.version === 1 && Array.isArray(data.results), 'Invalid CI adapter output')
  checkFields(data, ['version', 'results'], 'CI adapter output')
  for (const result of data.results) {
    requireValid(isObject(result) && isText(result.identity) && outcomes.has(result.status),
      'Invalid CI adapter result')
  }
  return data.results.map(({ identity, status }) => ({ identity, status }))
}

function countStatuses(rows, values) {
  const counts = Object.fromEntries(Array.from(values, value => [value, 0]))
  for (const row of rows) counts[row.status]++
  return counts
}

function addResult(index, identity, result) {
  if (!index.has(identity)) index.set(identity, [])
  index.get(identity).push(result)
}

async function collectEvidence(manifestPath, releaseSha, sample, mapping) {
  const evidence = { runs: new Map(), observations: new Map(), runtimeDefects: null, claims: {}, errors: [] }
  if (!manifestPath) return evidence
  const root = dirname(resolve(manifestPath))
  const load = async path => readJson(await readRelative(root, path), path)
  const attempt = async (source, action) => {
    try {
      return await action()
    } catch (error) {
      evidence.errors.push(`${source}: ${error.message}`)
      return null
    }
  }
  const manifest = await attempt('Manifest', async () => {
    const data = readJson(await readFile(manifestPath), manifestPath)
    checkBinding(data, releaseSha, sample, manifestPath)
    checkFields(data, ['version', 'sample', 'releaseSha', 'runs', 'observations', 'runtimeDefects',
      'ledger', 'demo', 'openCritical', 'openHigh'], manifestPath)
    requireValid(Array.isArray(data.runs), 'Expected runs array')
    evidence.claims = Object.fromEntries(Object.entries(data).filter(([key]) =>
      ['ledger', 'demo', 'openCritical', 'openHigh'].includes(key)))
    return data
  })
  if (!manifest) return evidence

  const artifacts = new Set()
  const conflictedJobs = new Set()
  for (const run of manifest.runs) {
    await attempt('CI run', async () => {
      requireValid(isObject(run) && isText(run.provenance) && isText(run.path), 'Invalid CI run descriptor')
      const provenance = await load(run.provenance)
      checkBinding(provenance, releaseSha, sample, run.provenance)
      const { job, runId, runAttempt, format, artifactSha256, source } = provenance
      requireValid([job, runId, source].every(isText) && Number.isSafeInteger(runAttempt) && runAttempt > 0 &&
        ['trx', 'ci-results-v1'].includes(format) && /^[a-f0-9]{64}$/.test(artifactSha256),
      `Invalid run provenance in ${run.provenance}`)
      if (evidence.runs.has(job) || conflictedJobs.has(job)) {
        evidence.runs.delete(job)
        conflictedJobs.add(job)
        throw new Error(`Multiple selected artifacts for CI job ${job}`)
      }
      const bytes = await readRelative(root, run.path)
      requireValid(sha256(bytes) === artifactSha256, `Evidence digest mismatch for ${run.path}`)
      requireValid(!artifacts.has(artifactSha256), `Repeated CI artifact ${run.path}`)
      const records = format === 'trx' ? readTrx(utf8(bytes)) : readAdapter(bytes)
      const results = new Map()
      for (const { identity, status } of records) addResult(results, identity, status)
      artifacts.add(artifactSha256)
      evidence.runs.set(job, {
        results,
        details: { job, runId, runAttempt, source, artifact: run.path, artifactSha256, provenance: run.provenance,
          runnerResults: countStatuses(records, outcomes) },
      })
    })
  }

  if (Object.hasOwn(manifest, 'observations')) {
    await attempt('Observations', async () => {
      const file = await load(manifest.observations)
      checkBinding(file, releaseSha, sample, manifest.observations)
      const entries = indexRows(file.entries, 'observation')
      for (const [id, row] of entries) {
        await attempt(id, async () => {
          const accept = mapping.cases.get(id)
          const expected = mapping.demos.has(id) ? 'demo' : accept?.evidenceSource
          requireValid(expected && expected !== 'ci' && row.kind === expected && outcomes.has(row.status) &&
            [row.observedBy, row.details, row.environment].every(isText),
          'Invalid observation or evidence source')
          requireValid(row.kind !== 'demo' || row.environment === 'staging', 'Demo evidence must come from staging')
          requireValid(row.kind !== 'device' || isText(row.device), 'Missing physical Android device details')
          const references = await readReferences(root, row.references)
          evidence.observations.set(id, { ...row, references })
        })
      }
    })
  }

  if (Object.hasOwn(manifest, 'runtimeDefects')) {
    evidence.runtimeDefects = await attempt('Runtime defects', async () => {
      const file = await load(manifest.runtimeDefects)
      checkBinding(file, releaseSha, sample, manifest.runtimeDefects)
      requireValid(typeof file.complete === 'boolean' && isText(file.reviewedBy), 'Missing runtime defect disposition')
      const defects = [...indexRows(file.defects, 'runtime defect').values()]
      for (const defect of defects) {
        requireValid(['CRITICAL', 'HIGH'].includes(defect.severity) &&
          ['OPEN', 'RESOLVED'].includes(defect.disposition) && isText(defect.details),
        `Invalid runtime defect disposition for ${defect.id}`)
      }
      const open = severity => defects.filter(row => row.severity === severity && row.disposition === 'OPEN').length
      return { complete: file.complete, reviewedBy: file.reviewedBy, defects,
        references: await readReferences(root, file.references),
        openCritical: open('CRITICAL'), openHigh: open('HIGH') }
    })
  }
  return evidence
}

function observed(row, evidence, missingStatus) {
  const observation = evidence.observations.get(row.id)
  if (!observation) return { ...row, status: missingStatus, reason: 'No valid execution record with referenced evidence' }
  return { ...row, status: observation.status === 'PASSED' ? 'VERIFIED' : observation.status,
    reason: observation.details, evidence: observation }
}

function evaluateCase(row, evidence) {
  if (!row.ci) return observed(row, evidence, 'MANUAL_DEVICE_REQUIRED')
  if (row.mappingState !== 'confirmed') {
    return { ...row, status: 'BLOCKED', reason: 'Full case-to-test mapping needs confirmation' }
  }

  const matches = row.tests.map(test => {
    const run = evidence.runs.get(test.job)
    return { ...test, outcomes: run?.results.get(test.identity) ?? [], artifact: run?.details.artifact ?? null }
  })
  const outcomes = matches.flatMap(match => match.outcomes)
  const result = (status, reason) => ({ ...row, status, reason, evidence: matches })
  if (outcomes.includes('FAILED')) return result('FAILED', 'A mapped execution failed')
  if (outcomes.includes('BLOCKED')) return result('BLOCKED', 'A mapped execution was inconclusive or interrupted')
  if (outcomes.includes('SKIPPED')) return result('SKIPPED', 'A mapped execution was skipped')
  if (matches.some(match => match.outcomes.length === 0)) return result('MISSING', 'A mapped test has no matching CI result')
  return result('VERIFIED', 'All mapped CI results passed')
}

function compareClaims(claims, expected, errors) {
  for (const [key, claim] of Object.entries(claims)) {
    const correct = expected[key]
    const matches = value => Number.isSafeInteger(value) && value >= 0
    const valid = isObject(correct)
      ? isObject(claim) && Object.keys(claim).length > 0 && Object.entries(claim).every(([name, value]) =>
        matches(value) && Object.hasOwn(correct, name) && value === correct[name])
      : matches(claim) && claim === correct
    if (!valid) errors.push(`Claimed ${key} counts do not match verified evidence`)
  }
}

export async function validate({ releaseSha, manifestPath, mappingPath = defaultMapping, sample = false }) {
  requireValid(shaPattern.test(releaseSha ?? ''), 'Specify a full, lowercase 40-hex release SHA')
  const mapping = validateMapping(readJson(await readFile(mappingPath), mappingPath))
  const evidence = await collectEvidence(manifestPath, releaseSha, sample, mapping)
  const cases = [...mapping.cases.values()].map(row => evaluateCase(row, evidence))
  const demos = [...mapping.demos.values()].map(row => observed(row, evidence, 'MISSING'))
  const statusCounts = countStatuses(cases, statuses)
  const { VERIFIED: passed, FAILED: failed, SKIPPED: skipped } = statusCounts
  const executed = passed + failed
  const ci = cases.filter(row => row.ci)
  const ciPassed = ci.filter(row => row.status === 'VERIFIED').length
  const mandatory = cases.filter(row => row.mandatoryMainPath)
  const mandatoryPassed = mandatory.filter(row => row.status === 'VERIFIED').length
  const demo = {
    main: demos.filter(row => row.kind === 'main' && row.status === 'VERIFIED').length,
    exception: demos.filter(row => row.kind === 'exception' && row.status === 'VERIFIED').length,
  }
  const { errors, runtimeDefects } = evidence
  const runtimeDefectStatus = !runtimeDefects?.complete ? 'BLOCKED'
    : runtimeDefects.openCritical + runtimeDefects.openHigh > 0 ? 'FAILED' : 'VERIFIED'
  const ledger = { unique: cases.length, ci: ci.length, ciPassed, passed, failed, skipped, executed }
  compareClaims(evidence.claims, { ledger, demo,
    openCritical: runtimeDefects?.complete ? runtimeDefects.openCritical : null,
    openHigh: runtimeDefects?.complete ? runtimeDefects.openHigh : null }, errors)
  const gates = {
    validInputs: errors.length === 0,
    allCasesExecuted: executed === cases.length,
    ci: ciPassed >= 24 && ciPassed === ci.length,
    overall: executed > 0 && passed * 100 >= executed * 95,
    mandatoryMainPaths: mandatoryPassed === mandatory.length,
    demos: demo.main === 6 && demo.exception === 6,
    runtimeDefects: runtimeDefectStatus === 'VERIFIED',
  }

  return {
    version: 1, releaseSha, sample, decision: Object.values(gates).every(Boolean) ? 'GO' : 'NO-GO',
    gates, errors, ledger, statusCounts, passRatePercent: executed ? passed / executed * 100 : null,
    mandatoryMainPaths: { passed: mandatoryPassed, total: mandatory.length },
    demo, runtimeDefectStatus, runtimeDefects, cases, demos,
    ciRuns: [...evidence.runs.values()].map(run => run.details),
    openByOwner: Object.groupBy(workflows.map(([workflow, owner]) => ({
      workflow, owner,
      cases: cases.filter(row => row.workflow === workflow && row.status !== 'VERIFIED')
        .map(({ id, status, reason }) => ({ id, status, reason })),
      demos: demos.filter(row => row.workflow === workflow && row.status !== 'VERIFIED')
        .map(({ id, status, reason }) => ({ id, status, reason })),
    })), group => group.owner),
  }
}

export function markdown(report) {
  const escape = value => String(value).replace(/[\r\n]+/g, ' ').replace(/[\\|`*_<>\[\]#&]/g, '\\$&')
  const { ledger, gates, errors, demo, mandatoryMainPaths, runtimeDefects } = report
  const lines = [
    `# ${report.sample ? 'SAMPLE · ' : ''}BM04 acceptance evidence`, '',
    ...(report.sample ? ['Synthetic example for validator testing. Keep this report out of release evidence.', ''] : []),
    `Release SHA \`${report.releaseSha}\` · **${report.decision}**`, '',
    `- Functional cases: ${ledger.unique} mapped, ${ledger.executed} executed, ${ledger.passed} passed, ${ledger.failed} failed and ${ledger.skipped} skipped.`,
    `- Designated CI: ${ledger.ciPassed}/${ledger.ci} verified; minimum 24.`,
    `- Executed pass rate: ${report.passRatePercent === null ? 'unavailable' : report.passRatePercent.toFixed(2) + '%'}; minimum 95%.`,
    `- Mandatory main paths: ${mandatoryMainPaths.passed}/${mandatoryMainPaths.total} verified.`,
    `- Staging demos: ${demo.main}/6 main and ${demo.exception}/6 exception verified.`,
    `- Runtime defects: ${report.runtimeDefectStatus}${runtimeDefects?.complete
      ? ` (${runtimeDefects.openCritical} open Critical, ${runtimeDefects.openHigh} open High)`
      : ' (complete release-SHA disposition required)'}.`, '',
    '## Gate checks', '',
    ...Object.entries(gates).map(([gate, passed]) => `- ${gate} — ${passed ? 'met' : 'open'}`), '',
    '## Open evidence by owner and workflow', '',
  ]
  for (const [owner, groups] of Object.entries(report.openByOwner)) {
    lines.push(`### ${owner}`, '')
    for (const group of groups) {
      lines.push(`**${group.workflow}**`, '')
      const open = [...group.cases, ...group.demos]
      lines.push(...(open.length ? open.map(row => `- ${row.id} · ${row.status} · ${escape(row.reason)}`) : ['- All evidence verified.']), '')
    }
  }
  const references = row => {
    if (Array.isArray(row.evidence)) return [...new Set(row.evidence.map(test => test.artifact).filter(Boolean))]
    return row.evidence?.references.map(ref => ref.path) ?? []
  }
  lines.push('## Functional case and demo results', '', '| ID | Status | Evidence files |',
    '| --- | --- | --- |', ...[...report.cases, ...report.demos]
      .map(row => `| ${row.id} | ${row.status} | ${references(row).map(escape).join(', ')} |`), '',
  '## Raw CI runner totals', '', 'These figures count runner result rows independently of the functional ledger.', '')
  for (const run of report.ciRuns) {
    lines.push(`- ${escape(run.job)} · run ${escape(run.runId)}, attempt ${run.runAttempt} · ${escape(run.artifact)} · ${Object.entries(run.runnerResults).map(([status, count]) => `${count} ${status.toLowerCase()}`).join(', ')}.`)
  }
  if (report.ciRuns.length === 0) lines.push('- No valid CI result artifacts supplied.')
  if (errors.length) lines.push('', '## Invalid evidence', '', ...errors.map(error => `- ${escape(error)}`))
  return lines.join('\n') + '\n'
}

async function main() {
  const { values } = parseArgs({ options: {
    sha: { type: 'string' }, manifest: { type: 'string' }, mapping: { type: 'string' },
    out: { type: 'string' }, sample: { type: 'boolean', default: false },
  } })
  requireValid(isText(values.out), 'Specify an output directory with --out')
  const report = await validate({ releaseSha: values.sha, manifestPath: values.manifest,
    mappingPath: values.mapping, sample: values.sample })
  await mkdir(values.out, { recursive: true })
  const name = report.sample ? 'SAMPLE-bm04' : 'bm04'
  await writeFile(join(values.out, `${name}.json`), JSON.stringify(report, null, 2) + '\n')
  await writeFile(join(values.out, `${name}.md`), markdown(report))
  console.log(`${report.sample ? 'SAMPLE ' : ''}${report.decision} · ${ledgerSummary(report.ledger)} · ${values.out}`)
  return report.errors.length ? 2 : report.decision === 'GO' ? 0 : 1
}

function ledgerSummary({ passed, unique, ciPassed, ci }) {
  return `${passed}/${unique} functional and ${ciPassed}/${ci} designated CI verified`
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error(`BM04 validation error: ${error.message}`)
    process.exitCode = 2
  }
}
