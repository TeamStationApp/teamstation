import { expect } from 'chai'
import { describe, it } from 'mocha'

import { requestDatabaseUrl, tessSettings } from './serverConfig'
import { asServerConfig } from './serverConfigSchema'

const readOnlySource = {
  endpoint: 'https://shared.example-ts.test',
  region: 'example-region',
  bucket: 'shared',
  accessKeyId: 'READONLYEXAMPLE',
  secretAccessKey: 'EXAMPLE',
  keys: ['images/team/demo/hash-96.png', 'videos/demo/video.mp4']
}

describe('read-only source configuration', function () {
  it('retains legacy default and configured writer behavior without a source', function () {
    expect(asServerConfig({}).space.readOnlySource).equals(undefined)
    expect(asServerConfig({ space: { bucket: 'writer' } }).space.bucket).equals(
      'writer'
    )
  })
  it('keeps separate writer/source fields and validates exact object keys', function () {
    const result = asServerConfig({
      space: { bucket: 'writer', pathStyle: true, readOnlySource }
    }).space
    expect(result.bucket).equals('writer')
    expect(result.pathStyle).equals(true)
    expect(result.readOnlySource).deep.equals({
      ...readOnlySource,
      pathStyle: false
    })
    expect(
      asServerConfig({
        space: {
          readOnlySource: { ...readOnlySource, pathStyle: true, keys: [] }
        }
      }).space.readOnlySource?.pathStyle
    ).equals(true)
  })
  for (const invalid of [
    {},
    { ...readOnlySource, keys: 'all' },
    { ...readOnlySource, keys: [12] },
    { ...readOnlySource, pathStyle: 'yes' }
  ]) {
    it('rejects malformed source fields and key lists', function () {
      expect(() =>
        asServerConfig({ space: { readOnlySource: invalid } })
      ).throws()
    })
  }
})

describe('Tess configuration', function () {
  const dictation = {
    apiKey: 'xai-placeholder',
    anthropic: { apiKey: 'dictation-anthropic-placeholder' }
  }

  it('loads a configuration without a tess section, with Tess off', function () {
    const config = asServerConfig({})
    expect(config.tess).equals(undefined)
    expect(tessSettings(config)).equals(null)
    // Dictation without an Anthropic key gives Tess nothing either.
    expect(
      tessSettings(asServerConfig({ dictation: { apiKey: 'xai-placeholder' } }))
    ).equals(null)
    expect(tessSettings(asServerConfig({ tess: { apiKey: '' } }))).equals(null)
  })

  it('falls back to dictation’s Anthropic key, and leaves dictation as it was', function () {
    const config = asServerConfig({ dictation })
    expect(tessSettings(config)).deep.equals({
      apiKey: 'dictation-anthropic-placeholder',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-5-5'
    })
    expect(config.dictation).deep.equals({
      apiKey: 'xai-placeholder',
      baseUrl: 'https://api.x.ai/v1',
      sttUrl: 'wss://api.x.ai/v1/stt',
      sttModel: 'grok-voice-transcribe-2.0',
      model: 'grok-4.3',
      openai: undefined,
      anthropic: {
        apiKey: 'dictation-anthropic-placeholder',
        baseUrl: 'https://api.anthropic.com/v1'
      }
    })
    // A section without a key still takes its address and model.
    expect(
      tessSettings(
        asServerConfig({
          dictation,
          tess: { baseUrl: 'http://127.0.0.1:1/v1', model: 'claude-test' }
        })
      )
    ).deep.equals({
      apiKey: 'dictation-anthropic-placeholder',
      baseUrl: 'http://127.0.0.1:1/v1',
      model: 'claude-test'
    })
  })

  it('prefers its own key, and refuses a malformed section', function () {
    expect(
      tessSettings(asServerConfig({ dictation, tess: { apiKey: 'tess-key' } }))
    ).deep.equals({
      apiKey: 'tess-key',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-5-5'
    })
    expect(() => asServerConfig({ tess: { apiKey: 42 } })).throws()
    expect(() => asServerConfig({ tess: 'on' })).throws()
  })
})

describe('the database addresses', function () {
  it('sends request traffic to the database when no pool is set', function () {
    const config = asServerConfig({
      databaseUrl: 'postgres://db.example.test/x'
    })
    expect(config.databasePoolUrl).equals('')
    expect(requestDatabaseUrl(config)).equals('postgres://db.example.test/x')
  })

  it('sends request traffic to the pool when one is set', function () {
    const config = asServerConfig({
      databaseUrl: 'postgres://db.example.test/x',
      databasePoolUrl: 'postgres://pool.example.test/pool'
    })
    expect(requestDatabaseUrl(config)).equals(
      'postgres://pool.example.test/pool'
    )
    expect(config.databaseUrl).equals('postgres://db.example.test/x')
  })

  it('runs background jobs unless a node says otherwise', function () {
    expect(asServerConfig({}).backgroundJobs).equals(true)
    expect(asServerConfig({ backgroundJobs: false }).backgroundJobs).equals(
      false
    )
  })

  it('sizes each role, with defaults for what is left out', function () {
    expect(asServerConfig({}).databasePoolSizes).deep.equals({
      worker: 10,
      primary: 3,
      statsBuilder: 3,
      ingest: 3
    })
    expect(
      asServerConfig({ databasePoolSizes: { worker: 4 } }).databasePoolSizes
    ).deep.equals({ worker: 4, primary: 3, statsBuilder: 3, ingest: 3 })
  })
})
