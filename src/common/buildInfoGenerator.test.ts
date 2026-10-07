import '../test/fixtureRoots.test'

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

const { bundleBuildInfo } = require('../../scripts/build-info.cjs') as {
  bundleBuildInfo: (root?: string, env?: Record<string, string>) => string
}
describe('public bundle provenance', () => {
  it('selects only public fields from supplied release metadata', () => {
    const supplied = {
      app: 'Example',
      version: '1.2.3',
      buildNumber: '54',
      branch: 'feature/one',
      commit: 'abc123',
      builtAt: '2026-01-02T00:00:00Z',
      secret: 'not-bundled'
    }
    const output = JSON.parse(
      bundleBuildInfo(undefined, { TS_BUILD_INFO: JSON.stringify(supplied) })
    )
    expect(output.version).equals('1.2.3')
    expect(output).not.has.property('secret')
    expect(() => bundleBuildInfo(undefined, { TS_BUILD_INFO: '{}' })).throws()
  })
  it('supports a source archive without Git and a normal checkout', async () => {
    const root = process.env.TS_BUILDS_TEST_ROOT
    if (root == null) throw new Error('Set TS_BUILDS_TEST_ROOT')
    const dir = await mkdtemp(path.join(root, 'metadata-'))
    try {
      await writeFile(path.join(dir, 'package.json'), '{"version":"1.0.0"}')
      const archive = JSON.parse(bundleBuildInfo(dir, {}))
      expect(archive.commit).equals('development')
      expect(archive.buildNumber).equals('development')
      expect(Date.parse(archive.builtAt)).not.equals(NaN)
      const checkout = JSON.parse(
        bundleBuildInfo(process.cwd(), { TS_BUILD_NUMBER: '55' })
      )
      expect(checkout.commit).matches(/^[a-f0-9]{40}$/)
      expect(checkout.buildNumber).equals('55')
    } finally {
      await rm(dir, { recursive: true })
    }
  })
})
