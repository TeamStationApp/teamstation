import { expect } from 'chai'
import { describe, it } from 'mocha'

import { readManifest } from './manifest'
import { selectScenarios } from './select'

describe('select', function () {
  const manifest = readManifest()
  const ids = (changed: string[]): string[] =>
    selectScenarios(manifest, changed).map(entry => entry.id)
  const all = manifest.scenarios.map(entry => entry.id)
  const streaming = all.filter(id => id.startsWith('streaming/'))

  it('runs every scenario for a change to the harness, its faults, shared rigs or fixture worlds', function () {
    expect(streaming.length).greaterThan(0)
    for (const file of [
      'e2e/core/run.ts',
      'e2e/faults/proxy.ts',
      'e2e/rigs/browserCoverage.ts',
      'src/server/dev/fixtures/streaming.ts'
    ]) {
      expect(ids([file]), file).deep.equals(all)
    }
  })

  it('runs the streaming scenarios for a change to a streaming rig, and nothing for an unrelated file', function () {
    expect(ids(['e2e/rigs/streaming/streamingSession.ts'])).deep.equals(
      streaming
    )
    expect(ids(['docs/notes.md'])).deep.equals([])
  })
})
