import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asServerConfig } from '../serverConfigSchema'
import { mediaOrigins, mediaOriginsOfJson } from './mediaOrigins'

const keys = { accessKeyId: 'id', secretAccessKey: 'secret' }

describe('mediaOrigins', function () {
  it('puts the primary origin first, from the override or PRIMARY_HOST', function () {
    expect(mediaOrigins(asServerConfig({}))).deep.equals([
      'https://app.teamstation.app',
      'https://*.mzstatic.com'
    ])
    expect(
      mediaOrigins(asServerConfig({ primaryUrlOverride: '127.0.0.1:9100' }))
    ).deep.equals(['http://127.0.0.1:9100', 'https://*.mzstatic.com'])
    expect(
      mediaOriginsOfJson({
        primaryUrlOverride: 'https://devhost1.example-ts.test/'
      })[0]
    ).equals('https://devhost1.example-ts.test')
  })

  it('adds the default bucket’s own subdomain once the keys are set', function () {
    expect(mediaOriginsOfJson({ space: keys })).deep.equals([
      'https://app.teamstation.app',
      'https://media-bucket.sfo3.digitaloceanspaces.com',
      'https://*.mzstatic.com'
    ])
  })

  it('names an explicit bucket, and the endpoint itself for path style', function () {
    expect(
      mediaOriginsOfJson({
        space: { ...keys, bucket: 'dev-media-bucket' }
      })[1]
    ).equals('https://dev-media-bucket.sfo3.digitaloceanspaces.com')
    expect(
      mediaOriginsOfJson({
        primaryUrlOverride: '192.0.2.40:9120',
        space: {
          ...keys,
          endpoint: 'http://192.0.2.40:9197',
          bucket: 'ts-local-chat',
          pathStyle: true
        }
      })
    ).deep.equals([
      'http://192.0.2.40:9120',
      'http://192.0.2.40:9197',
      'https://*.mzstatic.com'
    ])
  })

  it('leaves the Space out without keys', function () {
    expect(
      mediaOriginsOfJson({ space: { accessKeyId: 'id', secretAccessKey: '' } })
    ).deep.equals(['https://app.teamstation.app', 'https://*.mzstatic.com'])
  })

  it('reads no file when the schema is imported', function () {
    // In a directory with a broken serverConfig.json: loading the schema
    // module (and mediaOrigins) must not touch it.
    const dir = mkdtempSync(join(tmpdir(), 'ts-schema-'))
    try {
      writeFileSync(join(dir, 'serverConfig.json'), '{ not json')
      const root = process.cwd()
      const out = execFileSync(
        process.execPath,
        [
          '-r',
          join(root, 'node_modules/sucrase/register'),
          '-e',
          `const m = require(${JSON.stringify(
            join(root, 'src/server/media/mediaOrigins.ts')
          )}); console.log(m.mediaOriginsOfJson({}).join(' '))`
        ],
        { cwd: dir, encoding: 'utf8' }
      )
      expect(out.trim()).equals(
        'https://app.teamstation.app https://*.mzstatic.com'
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
