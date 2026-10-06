import { expect } from 'chai'
import { describe, it } from 'mocha'

import { testPasswordParameters } from '../../test/passwordFixtures'
import { passwordKdf, workerPasswordKdf } from './passwordKdf'
import { nativePasswordKdf } from './passwordKdfNative'

describe('password platform adapters', () => {
  it('clears native input/output bytes and checks results', async () => {
    let seen: Uint8Array | undefined
    const output = new Uint8Array(32).fill(171)
    expect(
      await nativePasswordKdf('secret', testPasswordParameters, async p => {
        seen = p.password
        expect(p.memory).equals(19456)
        expect(p.version).equals(19)
        return output
      })
    ).equals('ab'.repeat(32))
    expect([...seen!].every(x => x === 0)).equals(true)
    expect([...output].every(x => x === 0)).equals(true)
    for (const [password, derive] of [
      ['x', async () => new Uint8Array(1)],
      ['a'.repeat(1025), async () => output],
      ['😀'.repeat(257), async () => output],
      [
        'x',
        async () => {
          throw new Error('failed')
        }
      ]
    ] as const) {
      try {
        await nativePasswordKdf(password, testPasswordParameters, derive)
        expect.fail('accepted')
      } catch (error) {
        expect(error).instanceOf(Error)
      }
    }
  })
  it('terminates a worker after success, malformed output, errors and timeouts', async () => {
    for (const mode of [
      'success',
      'malformed',
      'error',
      'throw',
      'reported',
      'timeout'
    ]) {
      let terminated = false
      const worker = {
        onmessage: null as null | ((event: unknown) => void),
        onerror: null as null | (() => void),
        terminate() {
          terminated = true
        },
        postMessage() {
          if (mode === 'throw') throw new Error('worker failed')
          if (mode === 'timeout') return
          queueMicrotask(() => {
            if (mode === 'error') worker.onerror?.()
            else
              worker.onmessage?.({
                data:
                  mode === 'reported'
                    ? { error: true }
                    : { hash: mode === 'malformed' ? 'bad' : 'ab'.repeat(32) }
              })
          })
        }
      }
      const derive = workerPasswordKdf(() => worker as unknown as Worker, 5)
      try {
        const value = await derive('secret', testPasswordParameters)
        expect(mode).equals('success')
        expect(value).length(64)
      } catch (error) {
        expect(mode).not.equals('success')
        expect(error).instanceOf(Error)
      }
      expect(terminated).equals(true)
    }
  })
  it('runs the actual WASM worker entry and returns sanitized errors', async () => {
    const previous = globalThis.self
    let result: unknown
    const scope = {
      onmessage: undefined as
        undefined | ((event: { data: unknown }) => Promise<void>),
      postMessage(value: unknown) {
        result = value
      }
    }
    Object.defineProperty(globalThis, 'self', {
      value: scope,
      configurable: true,
      writable: true
    })
    try {
      await import('./passwordWorker')
      await scope.onmessage!({
        data: {
          password: 'Argon2 parity: é😀',
          parameters: testPasswordParameters
        }
      })
      expect(result).deep.equals({
        hash: 'd12fff922594f23bcece092625514a6085a867d68fbbc328935c13376c83fd31'
      })
      await scope.onmessage!({ data: { password: 'secret', parameters: null } })
      expect(result).deep.equals({ error: true })
    } finally {
      Object.defineProperty(globalThis, 'self', {
        value: previous,
        configurable: true,
        writable: true
      })
    }
  })
  it('fails locally when Workers are unavailable or inputs are oversized', async () => {
    for (const derive of [
      passwordKdf,
      workerPasswordKdf(() => {
        throw new Error('unavailable')
      })
    ])
      try {
        await derive('secret', testPasswordParameters)
        expect.fail('accepted')
      } catch (error) {
        expect(String(error)).includes('unavailable')
      }
    try {
      await passwordKdf('x'.repeat(1025), testPasswordParameters)
      expect.fail('accepted')
    } catch (error) {
      expect(String(error)).includes('too long')
    }
  })
})
