import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, globalAgent, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { afterEach, beforeEach, describe, it } from 'mocha'

import type { Upload } from './config'
import { app, testRoot } from './config.test'
import { redact } from './redact'
import { fingerprint, type Package, upload } from './upload'
export interface Endpoint {
  server: Server
  origin: string
  requests: Array<{ path: string; body: string }>
  statuses: Array<number | 'disconnect' | 'invalid' | 'large' | 'hold'>
  result: {
    id: number
    bundle_id: string
    release_version: string
    build_version: string
    git_commit: string
  }
  close: () => Promise<void>
}
export async function endpoint(root: string): Promise<Endpoint> {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=Fixture',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-keyout',
      path.join(root, 'tls.key'),
      '-out',
      path.join(root, 'tls.crt')
    ],
    { stdio: 'ignore' }
  )
  const ca = readFileSync(path.join(root, 'tls.crt'))
  const previousCa = globalAgent.options.ca
  globalAgent.options.ca = ca
  const requests: Endpoint['requests'] = []
  const statuses: Endpoint['statuses'] = []
  const result = {
    id: 7,
    bundle_id: app,
    release_version: '1.2.3',
    build_version: '1.0.42',
    git_commit: 'a'.repeat(40)
  }
  const server = createServer(
    { cert: ca, key: readFileSync(path.join(root, 'tls.key')) },
    (req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString()
        requests.push({ path: req.url ?? '/', body })
        if (req.method === 'POST') {
          const custom = /name="custom_fields"\r\n\r\n([^\r]+)\r\n/.exec(body)
          if (custom != null) {
            const fields = JSON.parse(custom[1]) as {
              mason: { buildNumber: string; version: string; bundleId: string }
            }
            Object.assign(result, {
              build_version: fields.mason.buildNumber,
              release_version: fields.mason.version,
              bundle_id: fields.mason.bundleId
            })
          }
          const commit = /name="git_commit"\r\n\r\n([^\r]+)\r\n/.exec(body)
          if (commit != null) result.git_commit = commit[1]
        }
        const status = statuses.shift() ?? (req.method === 'GET' ? 200 : 201)
        if (status === 'disconnect') {
          res.destroy()
          return
        }
        if (status === 'hold') return
        if (status === 'invalid') {
          res.writeHead(201)
          res.end('bad json')
          return
        }
        if (status === 'large') {
          res.writeHead(201)
          res.end('x'.repeat(1048577))
          return
        }
        res.writeHead(status, {
          'Content-Type': 'application/json',
          ...(status === 302
            ? { Location: 'https://elsewhere.example.test' }
            : {})
        })
        res.end(JSON.stringify(result))
      })
    }
  ).listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    server,
    origin: `https://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    statuses,
    result,
    close: async () => {
      globalAgent.options.ca = previousCa
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    }
  }
}
let root: string, service: Endpoint, config: Upload, file: Package
const signal = (): AbortSignal => new AbortController().signal
const fast = async (): Promise<void> => {}
describe('Portable Zealot and Mason uploader', () => {
  beforeEach(async () => {
    root = testRoot('upload-')
    service = await endpoint(root)
    const tokenFile = path.join(root, 'token.json')
    writeFileSync(
      tokenFile,
      JSON.stringify({
        schemaVersion: 1,
        origin: service.origin,
        token: 'synthetic-upload-token',
        expiresAt: null
      }),
      { mode: 0o600 }
    )
    config = {
      kind: 'mason',
      origin: service.origin,
      tokenFile,
      channelKey: 'fixture'
    }
    const artifact = path.join(root, 'fixture.ipa')
    writeFileSync(artifact, 'synthetic-package')
    file = {
      file: artifact,
      bundleId: app,
      version: '1.2.3',
      buildNumber: '1.0.42',
      branch: 'feature/example',
      commit: 'a'.repeat(40),
      buildTime: '2026-01-01T00:00:00Z',
      ...(await fingerprint(artifact))
    }
  })
  afterEach(async () => {
    delete process.env.FIXTURE_UPLOAD_CREDENTIAL
    delete process.env.DEPLOY_UPLOAD_CREDENTIAL
    await service.close()
    rmSync(root, { recursive: true, force: true })
  })
  it('uses the Mason stored secret ahead of a legacy file without changing Zealot credentials', async () => {
    const credential = readFileSync(config.tokenFile!, 'utf8')
    process.env.DEPLOY_UPLOAD_CREDENTIAL = '{invalid'
    assert.equal(
      await upload({ ...config, kind: 'zealot' }, file, signal(), fast),
      7
    )
    process.env.DEPLOY_UPLOAD_CREDENTIAL = credential
    rmSync(config.tokenFile!)
    assert.equal(await upload(config, file, signal(), fast), 7)
    process.env.DEPLOY_UPLOAD_CREDENTIAL = ''
    await assert.rejects(
      upload(config, file, signal(), fast),
      /Missing upload credential secret/
    )
    process.env.DEPLOY_UPLOAD_CREDENTIAL = '{invalid'
    process.env.FIXTURE_UPLOAD_CREDENTIAL = credential
    assert.equal(
      await upload(
        {
          ...config,
          tokenFile: undefined,
          credentialEnv: 'FIXTURE_UPLOAD_CREDENTIAL'
        },
        file,
        signal(),
        fast
      ),
      7
    )
  })
  it('uploads with a stored environment credential and no credential file', async () => {
    process.env.FIXTURE_UPLOAD_CREDENTIAL = readFileSync(
      config.tokenFile!,
      'utf8'
    )
    rmSync(config.tokenFile!)
    const { tokenFile: _unused, ...rest } = config
    assert.equal(
      await upload(
        { ...rest, credentialEnv: 'FIXTURE_UPLOAD_CREDENTIAL' },
        file,
        signal(),
        fast
      ),
      7
    )
    assert(service.requests[0].body.includes('synthetic-upload-token'))
    assert.equal(redact('synthetic-upload-token'), '[redacted]')
    assert.equal(redact(process.env.FIXTURE_UPLOAD_CREDENTIAL), '[redacted]')
  })
  it('rejects missing, malformed, expired and wrong-origin environment credentials before sending', async () => {
    const { tokenFile: _unused, ...rest } = config
    const secret = { ...rest, credentialEnv: 'FIXTURE_UPLOAD_CREDENTIAL' }
    const valid = JSON.parse(readFileSync(config.tokenFile!, 'utf8'))
    await assert.rejects(
      upload(secret, file, signal(), fast),
      /Missing upload credential secret/
    )
    for (const value of ['', '{bad', '{}']) {
      process.env.FIXTURE_UPLOAD_CREDENTIAL = value
      await assert.rejects(
        upload(secret, file, signal(), fast),
        /upload credential secret/
      )
    }
    for (const extra of [
      { origin: 'https://other.example.test' },
      { expiresAt: 1 }
    ]) {
      process.env.FIXTURE_UPLOAD_CREDENTIAL = JSON.stringify({
        ...valid,
        ...extra
      })
      await assert.rejects(
        upload(secret, file, signal(), fast),
        /origin or expiry/
      )
    }
    assert.equal(service.requests.length, 0)
    await assert.rejects(
      upload(rest, file, signal(), fast),
      /Missing upload credential source/
    )
  })
  it('streams leading credentials without URL secrets and validates returned build identity', async () => {
    assert.equal(await upload(config, file, signal(), fast), 7)
    const request = service.requests[0]
    assert.equal(request.path, '/api/apps/upload')
    assert(
      request.body.indexOf('name="token"') < request.body.indexOf('name="file"')
    )
    assert(request.body.includes('synthetic-package'))
    service.result.id = 0
    await assert.rejects(upload(config, file, signal(), fast))
    service.result.id = 7
    service.statuses.push('invalid')
    await assert.rejects(upload(config, file, signal(), fast))
    service.statuses.push('large')
    await assert.rejects(upload(config, file, signal(), fast))
  })
  it('retries only transient failures and resolves an uncertain Zealot publication before retry', async () => {
    service.statuses.push(500, 429, 201)
    assert.equal(await upload(config, file, signal(), fast), 7)
    assert.equal(service.requests.length, 3)
    service.requests.length = 0
    service.statuses.push('disconnect', 200)
    assert.equal(
      await upload({ ...config, kind: 'zealot' }, file, signal(), fast),
      7
    )
    assert(service.requests[1].path.startsWith('/api/apps/version_exist?'))
    assert.equal(service.requests.length, 2)
    service.statuses.push(500, 404, 201)
    assert.equal(
      await upload({ ...config, kind: 'zealot' }, file, signal(), fast),
      7
    )
    service.statuses.push(500, 401)
    await assert.rejects(
      upload({ ...config, kind: 'zealot' }, file, signal(), fast),
      /safely resolve/
    )
    for (const status of [302, 400, 401, 403, 409]) {
      service.statuses.push(status)
      const count: number = service.requests.length
      await assert.rejects(upload(config, file, signal(), fast))
      assert.equal(service.requests.length, count + 1)
    }
    service.statuses.push(500, 500, 500, 500)
    await assert.rejects(upload(config, file, signal(), fast))
  })
  it('rejects changed files, symlinks, expired/wrong-origin credentials and cancellation', async () => {
    const ca = globalAgent.options.ca
    globalAgent.options.ca = undefined
    let attempts = 0
    try {
      await assert.rejects(
        upload(config, file, signal(), async () => {
          attempts++
        }),
        /TLS verification/
      )
      assert.equal(attempts, 0)
    } finally {
      globalAgent.options.ca = ca
    }
    await assert.rejects(
      upload(config, { ...file, digest: 'b'.repeat(64) }, signal(), fast),
      /changed/
    )
    symlinkSync(file.file, path.join(root, 'link.ipa'))
    await assert.rejects(fingerprint(path.join(root, 'link.ipa')))
    writeFileSync(path.join(root, 'empty.ipa'), '')
    await assert.rejects(fingerprint(path.join(root, 'empty.ipa')))
    for (const extra of [
      { origin: 'https://other.example.test' },
      { expiresAt: 1 }
    ]) {
      writeFileSync(
        config.tokenFile!,
        JSON.stringify({
          schemaVersion: 1,
          origin: service.origin,
          token: 'synthetic-upload-token',
          ...extra
        })
      )
      await assert.rejects(
        upload(config, file, signal(), fast),
        /origin or expiry/
      )
    }
    writeFileSync(
      config.tokenFile!,
      JSON.stringify({
        schemaVersion: 1,
        origin: service.origin,
        token: 'synthetic-upload-token'
      })
    )
    const cancel = new AbortController()
    service.statuses.push('hold')
    const pending = upload(config, file, cancel.signal, fast)
    setTimeout(() => {
      cancel.abort()
    }, 30)
    await assert.rejects(pending)
    await assert.rejects(upload(config, file, cancel.signal, fast))
    const backoff = new AbortController()
    service.statuses.push(500)
    const retry = upload(config, file, backoff.signal)
    setTimeout(() => {
      backoff.abort()
    }, 30)
    await assert.rejects(retry, /cancelled/)
  })
})
