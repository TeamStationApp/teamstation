import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'

export const RECOVERY_BROWSER_FOLLOWUP_SCENARIOS = [
  'S1',
  'S2',
  'S4',
  'S4full',
  'S5',
  'S6',
  'S9',
  'S10',
  'composeFull',
  'picker',
  'reviewNavigation',
  'currentHistoryReply'
] as const

export interface RecoveryFixtureOwner {
  disposable: true
  source: string
  branch: string
  databaseUrl: string
  apiUrl: string
  webUrl: string
  artifacts: string
}

/** Check ownership before any seed/reset, credential read or UI attachment. */
export function validateRecoveryOwner(
  owner: RecoveryFixtureOwner,
  actual: {
    source: string
    branch: string
    databaseUrl: string
  }
): void {
  assert.equal(owner.disposable, true)
  assert(/^[a-f0-9]{40}$/.test(owner.source))
  assert.equal(owner.source, actual.source, 'Fixture source changed')
  assert.equal(owner.branch, actual.branch, 'Fixture belongs to another branch')
  const branch = /^paul\/([a-z][a-zA-Z0-9]+)$/.exec(owner.branch)?.[1]
  assert(
    branch != null && branch !== 'tester',
    'An owned task branch is required'
  )
  assert.equal(
    owner.databaseUrl,
    actual.databaseUrl,
    'API configuration points elsewhere'
  )
  const database = new URL(owner.databaseUrl)
  assert(['postgres:', 'postgresql:'].includes(database.protocol))
  assert(['localhost', '127.0.0.1', '[::1]'].includes(database.hostname))
  assert.equal(decodeURIComponent(database.pathname), '/TeamStation_' + branch)
  assert.equal(
    database.port,
    '5433',
    'Only the dedicated local test cluster is allowed'
  )
  for (const [value, path] of [
    [owner.apiUrl, '/api/v1'],
    [owner.webUrl, '/']
  ]) {
    const url = new URL(value)
    assert.equal(url.protocol, 'http:')
    assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    assert.equal(url.pathname, path)
    assert.equal(url.username + url.password + url.search + url.hash, '')
  }
  assert(isAbsolute(owner.artifacts))
}

/** A shell file is data: quote every value, including paths with apostrophes. */
export function recoveryFixtureEnvironment(
  values: Record<string, string>
): string {
  const lines: string[] = [
    '# Generated private disposable-fixture environment.'
  ]
  for (const [name, value] of Object.entries(values)) {
    assert(/^[A-Z][A-Z0-9_]*$/.test(name))
    assert(!value.includes('\0'))
    lines.push(`export ${name}='${value.replaceAll("'", "'\\''")}'`)
  }
  return lines.join('\n') + '\n'
}

export function requireFixtureFields(value: unknown, fields: string[]): void {
  assert(value != null && typeof value === 'object')
  for (const field of fields) {
    let current: unknown = value
    for (const part of field.split('.')) {
      assert(
        current != null && typeof current === 'object',
        'Missing fixture field ' + field
      )
      current = (current as Record<string, unknown>)[part]
    }
    assert(current != null && current !== '', 'Missing fixture field ' + field)
    if (Array.isArray(current))
      assert(current.length > 0, 'Empty fixture field ' + field)
  }
}
