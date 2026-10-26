import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'

/**
 * `NativeChatCrypto` as a phone loads it: the TurboModule React Native
 * registered under that name, or null in a build without it. React Native
 * itself is replaced in the module cache by a registry of this test's.
 */
const reactNative = require.resolve('react-native')
const spec = require.resolve('./NativeChatCrypto')

function loadWith(modules: Record<string, unknown>): {
  module: unknown
  asked: string[]
} {
  const asked: string[] = []
  Reflect.deleteProperty(require.cache, spec)
  require.cache[reactNative] = {
    id: reactNative,
    filename: reactNative,
    loaded: true,
    exports: {
      TurboModuleRegistry: {
        get: (name: string) => {
          asked.push(name)
          return modules[name] ?? null
        }
      }
    }
  } as unknown as NodeJS.Module
  const loaded = require('./NativeChatCrypto') as { default: unknown }
  return { module: loaded.default, asked }
}

describe('the chat crypto TurboModule spec', function () {
  afterEach(function () {
    Reflect.deleteProperty(require.cache, spec)
    Reflect.deleteProperty(require.cache, reactNative)
  })

  it('is the module registered as NativeChatCrypto', function () {
    const module = { call: () => new ArrayBuffer(0) }
    const loaded = loadWith({ NativeChatCrypto: module })
    expect(loaded.asked).deep.equals(['NativeChatCrypto'])
    expect(loaded.module).equals(module)
  })

  it('is null in a build without it', function () {
    expect(loadWith({}).module).equals(null)
  })
})
