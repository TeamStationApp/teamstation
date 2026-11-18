import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { mock } from 'node:test'

import { expect } from 'chai'
import { it } from 'mocha'

import {
  buildInfoJson,
  sourceIndexFixture
} from '../../../test/sourceIndexFixture'
import { sourceIndexCli, sourceIndexMain } from './cli'

it('validates build arguments, creates an index and reports command errors', () => {
  const f = sourceIndexFixture()
  const log = mock.method(console, 'log', () => {})
  const error = mock.method(console, 'error', () => {})
  const previous = process.env.TS_BUILD_INFO
  const exitCode = process.exitCode
  try {
    process.env.TS_BUILD_INFO = buildInfoJson('fixture-cli')
    sourceIndexCli(['build', '--root', f.root])
    expect(existsSync(f.index)).equals(true)
    expect(JSON.parse(String(log.mock.calls[0].arguments[0])).commit).equals(
      'fixture-cli'
    )
    const alternate = join(f.root, 'alternate.db')
    sourceIndexCli(['build', '--root', f.root, '--out', alternate])
    expect(existsSync(alternate)).equals(true)
    sourceIndexMain(['wrong'])
    expect(String(error.mock.calls[0].arguments[0])).includes('Usage:')
    expect(process.exitCode).equals(1)
    expect(() => {
      sourceIndexCli(['wrong'])
    }).throws('Usage:')
    expect(() => {
      sourceIndexCli(['build', '--unknown'])
    }).throws()
  } finally {
    error.mock.restore()
    log.mock.restore()
    process.exitCode = exitCode
    if (previous == null) delete process.env.TS_BUILD_INFO
    else process.env.TS_BUILD_INFO = previous
    f.close()
  }
})
