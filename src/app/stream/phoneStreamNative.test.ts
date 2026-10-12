// The DOM these tests render into. `npm test` and `coverage.app` load it already; the server's
// coverage scripts run every `src/**/*.test.ts` without it, so the file brings its own.
import '../../test/scoringDomSetup.cjs'

import Module from 'node:module'

import { expect } from 'chai'
import { describe, it } from 'mocha'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'

import { fakePhoneStreamModule, STATUS_EVENT } from './fakePhoneStreamModule'
import type * as NativeFacadeModule from './phoneStream.native'

type NativeFacade = typeof NativeFacadeModule

/**
 * Loads `phoneStream.native` against a stand-in `react-native`, so the
 * module lookup, the Android permission host and the preview component are
 * the ones a phone build wires up.
 */
function load(reactNative: Record<string, unknown>): NativeFacade {
  const rn = require.resolve('react-native')
  const files = [
    './phoneStream.native',
    './NativePhoneStream',
    './TSPhoneStreamPreviewNativeComponent'
  ].map(file => require.resolve(file))
  const original = require.cache[rn]
  const replacement = new Module(rn)
  replacement.exports = reactNative
  require.cache[rn] = replacement
  for (const file of files) Reflect.deleteProperty(require.cache, file)
  try {
    return require('./phoneStream.native') as NativeFacade
  } finally {
    if (original == null) Reflect.deleteProperty(require.cache, rn)
    else require.cache[rn] = original
    for (const file of files) Reflect.deleteProperty(require.cache, file)
  }
}

const flush = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('phone streaming on a phone', function () {
  ;(globalThis as { __DEV__?: boolean }).__DEV__ = true

  it('finds TSPhoneStream, asks Android for permissions, and draws the preview component', async function () {
    const native = fakePhoneStreamModule({
      capabilities: { supported: true, deviceModel: 'Google Pixel 10' }
    })
    const looked: string[] = []
    const asked: string[][] = []
    const facade = load({
      Platform: { OS: 'android', Version: 34 },
      PermissionsAndroid: {
        RESULTS: { GRANTED: 'granted' },
        requestMultiple: async (wanted: string[]) => {
          asked.push(wanted)
          return Object.fromEntries(wanted.map(name => [name, 'granted']))
        }
      },
      TurboModuleRegistry: {
        get: (name: string) => {
          looked.push(name)
          return native
        }
      },
      codegenNativeComponent: (name: string) => `host:${name}`
    })
    expect(looked).deep.equals(['TSPhoneStream'])
    expect(facade.PhoneStreamPreview).equals('host:TSPhoneStreamPreview')
    await facade.phoneStream.open('Home Plate')
    expect(asked).deep.equals([
      ['android.permission.CAMERA', 'android.permission.RECORD_AUDIO']
    ])
    expect(native.calls[0]).deep.equals({
      name: 'open',
      args: ['Home Plate', true, []]
    })

    const lines: string[] = []
    facade.reportPhoneStreamCapabilities(line => lines.push(line))
    facade.reportPhoneStreamCapabilities(line => lines.push(line))
    await flush()
    expect(lines).deep.equals([
      'phoneStream capabilities supported=true deviceModel=Google Pixel 10'
    ])

    const seen: unknown[] = []
    function Probe(): null {
      seen.push(
        facade.usePhoneStreamStatus(),
        facade.useRadarState(),
        facade.useRecordings().recordings
      )
      return null
    }
    const root = createRoot(document.createElement('div'))
    act(() => {
      root.render(createElement(Probe))
    })
    act(() => {
      native.emitStatus(STATUS_EVENT)
    })
    expect(seen.at(-3)).to.include({ phase: 'live' })
    act(() => {
      root.unmount()
    })
  })

  it('keeps quiet when the capabilities cannot be read, and outside a development build', async function () {
    const native = fakePhoneStreamModule()
    native.failures.capabilities = new Error('gone')
    const facade = load({
      Platform: { OS: 'ios', Version: '18.0' },
      PermissionsAndroid: {},
      TurboModuleRegistry: { get: () => native },
      codegenNativeComponent: () => 'host'
    })
    const lines: string[] = []
    facade.reportPhoneStreamCapabilities(line => lines.push(line))
    await flush()
    expect(lines).deep.equals([
      'phoneStream capabilities supported=false deviceModel='
    ])
    const quiet = load({
      Platform: { OS: 'ios', Version: '18.0' },
      PermissionsAndroid: {},
      TurboModuleRegistry: { get: () => null },
      codegenNativeComponent: () => 'host'
    })
    ;(globalThis as { __DEV__?: boolean }).__DEV__ = false
    try {
      quiet.reportPhoneStreamCapabilities(line => lines.push(line))
      await flush()
    } finally {
      ;(globalThis as { __DEV__?: boolean }).__DEV__ = true
    }
    expect(lines).has.length(1)
    // With no module, an iPhone opens nothing and asks for nothing.
    try {
      await quiet.phoneStream.open('Home Plate')
      expect.fail('open resolved')
    } catch (error) {
      expect(error).to.include({ code: 'unsupported' })
    }
  })
})
