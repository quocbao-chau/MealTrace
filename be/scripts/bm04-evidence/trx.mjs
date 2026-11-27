const namespace = 'http://microsoft.com/schemas/VisualStudio/TeamTest/2010'
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(value) {
  return value.replace(/&([^;]*);|&/g, (_, entity) => {
    if (Object.hasOwn(entities, entity)) return entities[entity]
    if (/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(entity ?? '')) {
      const code = entity[1].toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1))
      return String.fromCodePoint(code)
    }
    throw new Error('Invalid TRX XML entity')
  })
}

function readXml(xml) {
  // Read the unprefixed XML emitted by VSTest. No DTDs, external entities or XML recovery.
  const token = /<!--[^]*?-->|<!\[CDATA\[[^]*?\]\]>|<\?xml\s[^]*?\?>|<\/?[\w:.-]+(?:[^<>"']|"[^"]*"|'[^']*')*>|[^<]+/gy
  const document = { children: [] }
  const stack = [document]
  let position = 0
  for (let match; (match = token.exec(xml)); position = token.lastIndex) {
    const value = match[0]
    if (value.startsWith('<?xml')) {
      if (position !== 0) throw new Error('Misplaced TRX XML declaration')
    } else if (value.startsWith('<!--')) {
      continue
    } else if (value.startsWith('</')) {
      const closing = /^<\/([\w:.-]+)\s*>$/.exec(value)
      if (stack.length === 1 || closing?.[1] !== stack.pop().name) throw new Error('Unbalanced TRX XML')
    } else if (/^<[\w:.-]/.test(value)) {
      const [, name, attributes, end] = /^<([\w:.-]+)([^]*?)(\/?)>$/.exec(value)
      const attrs = Object.create(null)
      let rest = attributes.trimEnd()
      while (rest) {
        const attr = /^\s+([\w:.-]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/.exec(rest)
        if (!attr || Object.hasOwn(attrs, attr[1])) throw new Error('Invalid TRX XML attribute')
        attrs[attr[1]] = decode(attr[2] ?? attr[3])
        rest = rest.slice(attr[0].length)
      }
      const node = { name, attrs, children: [] }
      stack.at(-1).children.push(node)
      if (!end) stack.push(node)
    } else if (stack.length === 1 && value.trim()) {
      throw new Error('Unexpected content outside TRX TestRun')
    }
  }
  if (position !== xml.length || stack.length !== 1 || document.children.length !== 1) {
    throw new Error('Malformed or unsupported TRX XML')
  }
  return document.children[0]
}

function one(node, name) {
  const matches = node.children.filter(child => child.name === name)
  if (matches.length !== 1) throw new Error(`TRX needs exactly one ${name}`)
  return matches[0]
}

const outcomes = new Map([
  ['Passed', ['passed', 'PASSED']],
  ['Failed', ['failed', 'FAILED']],
  ['NotExecuted', ['notExecuted', 'SKIPPED']],
  ['Error', ['error', 'FAILED']],
  ['Timeout', ['timeout', 'FAILED']],
  ['Aborted', ['aborted', 'BLOCKED']],
  ['Inconclusive', ['inconclusive', 'BLOCKED']],
  ['NotRunnable', ['notRunnable', 'BLOCKED']],
  ['PassedButRunAborted', ['passedButRunAborted', 'BLOCKED']],
  ['Disconnected', ['disconnected', 'BLOCKED']],
  ['Warning', ['warning', 'BLOCKED']],
  ['InProgress', ['inProgress', 'BLOCKED']],
  ['Pending', ['pending', 'BLOCKED']],
])

export function readTrx(xml) {
  const run = readXml(xml)
  if (run.name !== 'TestRun' || run.attrs.xmlns !== namespace || !run.attrs.id) {
    throw new Error('Expected a VSTest 2010 TRX TestRun with an ID')
  }
  const methods = new Map()
  for (const definition of one(run, 'TestDefinitions').children) {
    const { id } = definition.attrs
    const { className, name } = one(definition, 'TestMethod').attrs
    if (definition.name !== 'UnitTest' || !id || !className || !name || methods.has(id)) {
      throw new Error('Invalid or duplicate TRX test definition')
    }
    methods.set(id, `${className}.${name}`)
  }
  const summary = one(run, 'ResultSummary')
  const { attrs: counters } = one(summary, 'Counters')
  if (!['Completed', 'Passed', 'Failed'].includes(summary.attrs.outcome)) {
    throw new Error('TRX run did not complete')
  }

  const counts = Object.fromEntries([...outcomes.values()].map(([counter]) => [counter, 0]))
  const results = one(run, 'Results').children.map(node => {
    const identity = methods.get(node.attrs.testId)
    const outcome = outcomes.get(node.attrs.outcome)
    if (node.name !== 'UnitTestResult' || !identity || !outcome ||
        node.children.some(child => child.name === 'InnerResults')) {
      throw new Error('Unsupported TRX result or missing test definition')
    }
    const [counter, status] = outcome
    counts[counter]++
    return { identity, status }
  })
  const expected = { total: results.length, executed: counts.passed + counts.failed, ...counts }
  for (const [key, count] of Object.entries(expected)) {
    const counter = counters[key] ?? (['total', 'executed', 'passed', 'failed'].includes(key) ? '' : '0')
    // VSTest 17.8 leaves notExecuted at zero even when it emits NotExecuted rows.
    if (key === 'notExecuted' && counter === '0') continue
    if (!/^\d+$/.test(counter) || Number(counter) !== count) {
      throw new Error(`TRX counter ${key} does not match result rows`)
    }
  }
  if (summary.attrs.outcome !== 'Failed' && results.some(result => result.status === 'FAILED')) {
    throw new Error('TRX summary outcome contradicts failed result rows')
  }
  return results
}
