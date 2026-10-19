import assert from 'node:assert/strict'
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, it } from 'mocha'

import { app, testRoot } from './config.test'
import { DeploymentToolError, Processes } from './process'
import { redact } from './redact'
import { apiKey, uploadToTestFlight } from './testflight'

/** What the fixture `.p8` holds; it must never reach arguments or logs. */
export const p8Body =
  'MIGTAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBHkwdwIBAQQgSyntheticKey'
/** Writes a private App Store Connect key file and its `.p8`; returns the key file. */
export function apiKeyFixture(root: string): string {
  writeFileSync(
    path.join(root, 'AuthKey_FIXTUREKEY.p8'),
    `-----BEGIN PRIVATE KEY-----\n${p8Body}\n-----END PRIVATE KEY-----\n`,
    { mode: 0o600 }
  )
  const file = path.join(root, 'appStoreConnect.json')
  writeFileSync(
    file,
    JSON.stringify({
      keyId: 'FIXTUREKEY',
      issuerId: '00000000-0000-4000-8000-00000000000a',
      keyFile: 'AuthKey_FIXTUREKEY.p8'
    }),
    { mode: 0o600 }
  )
  return file
}
/**
 * An `xcrun` that records its arguments in `xcrun-args.txt`, prints
 * `xcrun-reply.txt` and exits with `xcrun-status.txt`.
 */
export function fakeXcrun(
  root: string,
  reply: object | string,
  status = 0
): string {
  writeFileSync(
    path.join(root, 'xcrun-reply.txt'),
    typeof reply === 'string' ? reply : JSON.stringify(reply, null, 2)
  )
  writeFileSync(path.join(root, 'xcrun-status.txt'), String(status))
  const file = path.join(root, 'xcrun')
  writeFileSync(
    file,
    `#!/bin/sh\nprintf '%s\\n' "$@" >> '${root}/xcrun-args.txt'\necho "Running altool at path '/fixture/altool'..." >&2\ncat '${root}/xcrun-reply.txt'\nexit $(cat '${root}/xcrun-status.txt')\n`,
    { mode: 0o700 }
  )
  return file
}
export function xcrunCalls(root: string): string[][] {
  let text: string
  try {
    text = readFileSync(path.join(root, 'xcrun-args.txt'), 'utf8')
  } catch {
    return []
  }
  return text
    .split(/\n(?=altool\n)/)
    .map(call => call.trim().split('\n'))
    .filter(call => call[0] === 'altool')
}
export const success = {
  'tool-version': '26.40.1',
  'os-version': '26.3.0',
  'success-message': "No errors uploading 'ios-appstore.ipa'",
  details: { 'delivery-uuid': '00000000-0000-4000-8000-000000000001' }
}
export const duplicateReply = {
  'tool-version': '26.40.1',
  'product-errors': [
    {
      code: 409,
      message: 'Validation failed',
      userInfo: {
        NSLocalizedFailureReason:
          "The bundle version must be higher than the previously uploaded version: '26093004'.",
        code: 'ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE'
      }
    }
  ]
}

let root: string, ipa: string
async function upload(xcrun: string): ReturnType<typeof uploadToTestFlight> {
  return await uploadToTestFlight({
    ipa,
    apiKey: apiKey(path.join(root, 'appStoreConnect.json')),
    appleId: '6824597245',
    bundleId: app,
    version: '1.2.3',
    buildNumber: '26093004',
    processes: new Processes(new AbortController().signal),
    tools: { xcrun }
  })
}
describe('TestFlight upload', () => {
  beforeEach(() => {
    root = testRoot('testflight-')
    ipa = path.join(root, 'ios-appstore.ipa')
    writeFileSync(ipa, 'fixture-store-package')
    apiKeyFixture(root)
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })
  it('passes exactly the altool arguments and reads success from its JSON', async () => {
    assert.deepEqual(await upload(fakeXcrun(root, success)), {
      alreadyPublished: false
    })
    assert.deepEqual(xcrunCalls(root), [
      [
        'altool',
        '--upload-package',
        ipa,
        '--type',
        'ios',
        '--apple-id',
        '6824597245',
        '--bundle-id',
        app,
        '--bundle-version',
        '26093004',
        '--bundle-short-version-string',
        '1.2.3',
        '--api-key',
        'FIXTUREKEY',
        '--api-issuer',
        '00000000-0000-4000-8000-00000000000a',
        '--p8-file-path',
        path.join(root, 'AuthKey_FIXTUREKEY.p8'),
        '--output-format',
        'json'
      ]
    ])
    // The key's path is an argument; what it holds is not.
    assert(
      !readFileSync(path.join(root, 'xcrun-args.txt'), 'utf8').includes(p8Body)
    )
  })
  it('reports a build number Apple already holds as published, whether altool fails or not', async () => {
    assert.deepEqual(await upload(fakeXcrun(root, duplicateReply, 1)), {
      alreadyPublished: true
    })
    assert.deepEqual(await upload(fakeXcrun(root, duplicateReply, 0)), {
      alreadyPublished: true
    })
    assert.deepEqual(
      await upload(
        fakeXcrun(
          root,
          "ERROR: Redundant Binary Upload. You've already uploaded a build with build number '26093004'.",
          1
        )
      ),
      { alreadyPublished: true }
    )
  })
  it('fails when Apple already holds a higher build number', async () => {
    const higher = JSON.parse(
      JSON.stringify(duplicateReply).replace('26093004', '26093010')
    )
    for (const status of [1, 0])
      await assert.rejects(upload(fakeXcrun(root, higher, status)))
  })
  it('throws a redacted error for any other result, never printing the key', async () => {
    const leak = {
      'product-errors': [
        {
          message: `Authentication failed for ${p8Body}`,
          userInfo: { NSLocalizedFailureReason: 'Invalid issuer' }
        }
      ]
    }
    for (const status of [1, 0]) {
      const error: unknown = await upload(fakeXcrun(root, leak, status)).then(
        () => assert.fail('upload accepted'),
        (caught: unknown) => caught
      )
      assert(error instanceof DeploymentToolError)
      assert.equal(error.tool, 'xcrun')
      const lines = error.lastLines(80).join('\n')
      assert(lines.includes('Authentication failed for [redacted]'))
      assert(!lines.includes(p8Body))
      assert(!error.message.includes(p8Body))
      assert(!redact(JSON.stringify(leak)).includes(p8Body))
    }
    await assert.rejects(
      upload(fakeXcrun(root, 'not json at all')),
      /not confirmed/
    )
    await assert.rejects(upload(fakeXcrun(root, '[]')), /not confirmed/)
    await assert.rejects(
      upload(fakeXcrun(root, { 'tool-version': '26.40.1' })),
      /not confirmed/
    )
  })
  it('requires private key files and a private key in the .p8', () => {
    const file = path.join(root, 'appStoreConnect.json')
    assert.equal(apiKey(file).keyFile, path.join(root, 'AuthKey_FIXTUREKEY.p8'))
    const p8 = path.join(root, 'AuthKey_FIXTUREKEY.p8')
    chmodSync(p8, 0o640)
    assert.throws(() => apiKey(file), /private regular/)
    chmodSync(p8, 0o600)
    chmodSync(file, 0o644)
    assert.throws(() => apiKey(file), /private regular/)
    chmodSync(file, 0o600)
    writeFileSync(p8, 'not a key', { mode: 0o600 })
    assert.throws(() => apiKey(file), /not a private key/)
    writeFileSync(file, JSON.stringify({ keyId: 'FIXTUREKEY' }), {
      mode: 0o600
    })
    assert.throws(() => apiKey(file), /insecure deployment configuration/)
    rmSync(file)
    assert.throws(() => apiKey(file))
  })
})
