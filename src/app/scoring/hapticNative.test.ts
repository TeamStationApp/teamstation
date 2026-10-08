import Module from 'node:module'

import { expect } from 'chai'
import { describe, it } from 'mocha'

const load = (
  mock: unknown,
  test: (light: (view?: unknown) => void) => void
): void => {
  const rn = require.resolve('react-native')
  const facade = require.resolve('./lightHaptic.native')
  const original = require.cache[rn]
  const prior = require.cache[facade]
  const replacement = new Module(rn)
  replacement.exports = mock
  require.cache[rn] = replacement
  Reflect.deleteProperty(require.cache, facade)
  try {
    test(require('./lightHaptic.native').lightHaptic)
  } finally {
    if (original == null) Reflect.deleteProperty(require.cache, rn)
    else require.cache[rn] = original
    if (prior == null) Reflect.deleteProperty(require.cache, facade)
    else require.cache[facade] = prior
  }
}

describe('native light feedback facade', function () {
  it('requests light feedback for the attached group tag', function () {
    const requests: number[] = []
    const names: string[] = []
    load(
      {
        findNodeHandle: () => 42,
        TurboModuleRegistry: {
          get: (name: string) => {
            names.push(name)
            return { light: (tag: number) => requests.push(tag) }
          }
        }
      },
      light => {
        light({})
        light(null)
      }
    )
    expect(names).deep.equals(['TSHaptics'])
    expect(requests).deep.equals([42])
  })
  it('is safe when an old binary has no bridge or a request fails', function () {
    load(
      { findNodeHandle: () => 42, TurboModuleRegistry: { get: () => null } },
      light => {
        expect(() => {
          light({})
        }).not.throws()
      }
    )
    load(
      {
        findNodeHandle: () => {
          throw new Error('Unmounted')
        }
      },
      light => {
        expect(() => {
          light({})
        }).not.throws()
      }
    )
    load(
      {
        findNodeHandle: () => 42,
        TurboModuleRegistry: {
          get: () => ({
            light: () => {
              throw new Error('Unavailable')
            }
          })
        }
      },
      light => {
        expect(() => {
          light({})
        }).not.throws()
      }
    )
  })
})
