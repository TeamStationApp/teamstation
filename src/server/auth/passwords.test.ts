import { expect } from 'chai'
import { describe, it } from 'mocha'

import { passwordBytes } from '../../common/passwordProtocol'
import {
  testPasswordKdf,
  testPasswordParameters
} from '../../test/passwordFixtures'
import {
  createPasswordRecord,
  decoyParameters,
  hashPassword,
  nativeArgon,
  PasswordHasher,
  passwordMatches,
  readPasswordRecord
} from './passwords'

describe('native server Argon2id', function () {
  this.timeout(30000)
  it('matches actual WASM bytes for Unicode and distinct adjustable parameters', async () => {
    for (const p of [
      testPasswordParameters,
      { ...testPasswordParameters, parallelism: 2, iterations: 3 }
    ]) {
      const password = 'Argon2 parity: é😀'
      expect(await nativeArgon(passwordBytes(password), p)).equals(
        await testPasswordKdf(password, p)
      )
    }
  })
  it('stores both independent parameter sets with only the final hash and verifies them', async () => {
    const proof = await testPasswordKdf(
      'invented password',
      testPasswordParameters
    )
    const stored = await createPasswordRecord(proof, testPasswordParameters)
    const record = readPasswordRecord(stored)!
    expect(record.client).deep.equals(testPasswordParameters)
    expect(record.server.iterations).equals(24)
    expect(record.server.salt).not.equals(record.client.salt)
    expect(stored).not.includes(proof)
    expect(stored).not.includes('invented password')
    expect(await passwordMatches(proof, stored)).equals(true)
    expect(await passwordMatches('ab'.repeat(32), stored)).equals(false)
    for (const value of [
      null,
      '',
      '$2b$11$not-an-argon-record',
      '{}',
      'null',
      JSON.stringify({ ...record, schema: 2 }),
      JSON.stringify({ ...record, hash: 'invalid' }),
      JSON.stringify({
        ...record,
        server: { ...record.server, iterations: 7 }
      }),
      JSON.stringify({
        ...record,
        server: { ...record.server, salt: record.client.salt }
      })
    ]) {
      expect(readPasswordRecord(value)).equals(null)
      expect(await passwordMatches(proof, value)).equals(false)
    }
    const seeded = await hashPassword('local synthetic seed password')
    const seedRecord = readPasswordRecord(seeded)!
    expect(
      await passwordMatches(
        await testPasswordKdf(
          'local synthetic seed password',
          seedRecord.client
        ),
        seeded
      )
    ).equals(true)
  })
  it('bounds native work and releases capacity even after failure', async () => {
    let release!: () => void
    const hasher = new PasswordHasher(async () => {
      await new Promise<void>(resolve => {
        release = resolve
      })
      return 'ab'.repeat(32)
    })
    const pending = hasher.run(new Uint8Array(), testPasswordParameters)
    try {
      await hasher.run(new Uint8Array(), testPasswordParameters)
      expect.fail('unbounded')
    } catch (error) {
      expect(String(error)).includes('busy')
    }
    release()
    await pending
    let fails = true
    const retry = new PasswordHasher(async () => {
      if (fails) throw new Error('native failure')
      return 'ab'.repeat(32)
    })
    try {
      await retry.run(new Uint8Array(), testPasswordParameters)
      expect.fail('failed')
    } catch (error) {
      expect(String(error)).includes('native failure')
    }
    fails = false
    expect(await retry.run(new Uint8Array(), testPasswordParameters)).length(64)
  })
  it('uses stable private decoy salts across requests and varies by normalized address', () => {
    expect(decoyParameters('a@example.com', 'fixture')).deep.equals(
      decoyParameters('a@example.com', 'fixture')
    )
    expect(decoyParameters('b@example.com', 'fixture').salt).not.equals(
      decoyParameters('a@example.com', 'fixture').salt
    )
  })
  it('reserves capacity for another account while bounding total native work', async () => {
    const releases: Array<() => void> = []
    const hasher = new PasswordHasher(async () => {
      await new Promise<void>(resolve => {
        releases.push(resolve)
      })
      return 'ab'.repeat(32)
    })
    const first = hasher.run(
      new Uint8Array(),
      testPasswordParameters,
      'account:1'
    )
    try {
      await hasher.run(
        new Uint8Array(),
        { ...testPasswordParameters, salt: 'ff'.repeat(16) },
        'account:1'
      )
      expect.fail('same account occupied another slot')
    } catch (error) {
      expect(String(error)).includes('busy')
    }
    const second = hasher.run(
      new Uint8Array(),
      testPasswordParameters,
      'account:2'
    )
    expect(releases).length(2)
    try {
      await hasher.run(new Uint8Array(), testPasswordParameters, 'account:3')
      expect.fail('exceeded total capacity')
    } catch (error) {
      expect(String(error)).includes('busy')
    }
    releases[1]()
    await second
    const third = hasher.run(
      new Uint8Array(),
      testPasswordParameters,
      'account:3'
    )
    expect(releases).length(3)
    releases[2]()
    await third
    releases[0]()
    await first
  })
})
