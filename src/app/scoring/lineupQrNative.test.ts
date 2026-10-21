// The DOM these tests render into: the coverage scripts run the .ts suites
// without the shared setup, so the file brings its own.
import '../../test/scoringDomSetup.cjs'

import Module from 'node:module'

import { expect } from 'chai'
import { describe, it } from 'mocha'
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

import { lineupQrFixture2 } from './lineupQr.fixtures'
import type * as LineupQrGlyphNative from './LineupQrGlyph.native'
import { lineupQrGlyphPaths } from './lineupQrGlyphs'
import { qrMatrix } from './lineupQrMatrix'
import type * as QrCodeNative from './QrCode.native'
import type * as QrScannerNative from './qrScanner.native'

interface Drawn {
  type: string
  name: string
  props: Record<string, unknown>
}

/** A host component that records its props and renders its children. */
const host =
  (type: string, drawn: Drawn[], name = type) =>
  (props: Record<string, unknown> & { children?: ReactNode }) => {
    const { children, ...rest } = props
    drawn.push({ type, name, props: rest })
    return createElement(type, {}, children)
  }

/**
 * Loads native twins against stand-in `react-native` and `react-native-svg`
 * modules, so what a phone build draws is what these tests see.
 */
function loadNative<T>(
  file: string,
  stand: Record<string, Record<string, unknown>>,
  also: string[] = []
): T {
  const names = Object.keys(stand).map(name => require.resolve(name))
  const originals = names.map(name => require.cache[name])
  const own = [file, ...also].map(path => require.resolve(path))
  Object.entries(stand).forEach(([name, exports], k) => {
    const replacement = new Module(names[k])
    replacement.exports = { __esModule: true, ...exports }
    require.cache[names[k]] = replacement
  })
  for (const path of own) Reflect.deleteProperty(require.cache, path)
  try {
    return require(file) as T
  } finally {
    names.forEach((name, k) => {
      if (originals[k] == null) Reflect.deleteProperty(require.cache, name)
      else require.cache[name] = originals[k]
    })
    for (const path of own) Reflect.deleteProperty(require.cache, path)
  }
}

const svgStandIn = (drawn: Drawn[]): Record<string, unknown> => ({
  default: host('svg', drawn),
  Path: host('path', drawn),
  Rect: host('rect', drawn)
})
const render = (element: ReturnType<typeof createElement>): void => {
  const root = createRoot(document.createElement('div'))
  act(() => {
    root.render(element)
  })
  act(() => {
    root.unmount()
  })
}

describe('lineup QR native twins', function () {
  it('draws the QR code as one native path on a white rect', function () {
    const drawn: Drawn[] = []
    const { QrCode } = loadNative<typeof QrCodeNative>('./QrCode.native', {
      'react-native-svg': svgStandIn(drawn)
    })
    render(
      createElement(QrCode, {
        text: lineupQrFixture2.text,
        size: 240,
        accessibilityLabel: 'Lineup QR code'
      })
    )
    const matrix = qrMatrix(lineupQrFixture2.text)
    const svg = drawn.find(node => node.type === 'svg')!
    expect(svg.props).deep.include({
      testID: 'qrCode',
      width: 240,
      accessible: true,
      accessibilityLabel: 'Lineup QR code'
    })
    expect(drawn.find(node => node.type === 'rect')!.props.fill).equals(
      '#ffffff'
    )
    expect(drawn.filter(node => node.type === 'path')).has.length(1)
    expect(drawn.find(node => node.type === 'path')!.props.d).equals(
      matrix.path
    )
  })

  it('draws both glyphs as native strokes', function () {
    const drawn: Drawn[] = []
    const { LineupQrGlyph } = loadNative<typeof LineupQrGlyphNative>(
      './LineupQrGlyph.native',
      { 'react-native-svg': svgStandIn(drawn) }
    )
    render(createElement(LineupQrGlyph, { kind: 'qr', color: '#fff' }))
    render(
      createElement(LineupQrGlyph, {
        kind: 'scan',
        color: '#0f0',
        size: 280,
        strokeWidth: 1
      })
    )
    const paths = drawn.filter(node => node.type === 'path')
    expect(paths.map(node => node.props.d)).deep.equals([
      lineupQrGlyphPaths.qr,
      lineupQrGlyphPaths.scan
    ])
    expect(paths[0].props.strokeWidth).equals(1.7)
    expect(paths[1].props).deep.include({ stroke: '#0f0', strokeWidth: 1 })
    expect(drawn.find(node => node.type === 'svg')!.props.width).equals(24)
  })
})

describe('the phone’s QR camera', function () {
  interface Scanner {
    QrScanner: typeof QrScannerNative.QrScanner
    qrScannerSupported: boolean
  }
  type Native = Record<string, unknown> & {
    active: boolean
    onCode: (event: { nativeEvent: { text: string } }) => void
    onStatus: (event: { nativeEvent: { status: string } }) => void
  }
  const camera = (
    os: string,
    request: () => Promise<string>,
    check: () => Promise<boolean> = async () => false
  ): { scanner: Scanner; drawn: Drawn[]; asked: string[] } => {
    const drawn: Drawn[] = []
    const asked: string[] = []
    const scanner = loadNative<Scanner>(
      './qrScanner.native',
      {
        'react-native': {
          Platform: { OS: os },
          PermissionsAndroid: {
            PERMISSIONS: { CAMERA: 'android.permission.CAMERA' },
            RESULTS: { GRANTED: 'granted' },
            request: async (permission: string) => {
              asked.push(permission)
              return await request()
            },
            check: async () => await check()
          },
          codegenNativeComponent: (name: string) => host(`div`, drawn, name)
        }
      },
      ['./TSQrScannerNativeComponent']
    )
    return { scanner, drawn, asked }
  }
  const last = (drawn: Drawn[]): Native =>
    drawn.filter(node => node.name === 'TSQrScanner').at(-1)!
      .props as unknown as Native
  const mount = (
    scanner: Scanner,
    active = true
  ): {
    codes: string[]
    statuses: string[]
    root: ReturnType<typeof createRoot>
  } => {
    const codes: string[] = []
    const statuses: string[] = []
    const root = createRoot(document.createElement('div'))
    act(() => {
      root.render(
        createElement(scanner.QrScanner, {
          active,
          onCode: (text: string) => codes.push(text),
          onStatus: (status: string) => statuses.push(status)
        })
      )
    })
    return { codes, statuses, root }
  }

  it('asks Android for the camera once the view has one, then turns it on', async function () {
    const { scanner, drawn, asked } = camera('android', async () => 'granted')
    expect(scanner.qrScannerSupported).equals(true)
    const { codes, statuses, root } = mount(scanner)
    expect(last(drawn).active).equals(false)
    expect(asked).deep.equals([])
    await act(async () => {
      last(drawn).onStatus({ nativeEvent: { status: 'available' } })
    })
    expect(asked).deep.equals(['android.permission.CAMERA'])
    expect(last(drawn).active).equals(true)
    act(() => {
      last(drawn).onStatus({ nativeEvent: { status: 'ready' } })
      last(drawn).onCode({ nativeEvent: { text: 'one' } })
      last(drawn).onCode({ nativeEvent: { text: 'one' } })
      last(drawn).onCode({ nativeEvent: { text: 'two' } })
      last(drawn).onStatus({ nativeEvent: { status: 'mystery' } })
    })
    expect(codes).deep.equals(['one', 'two'])
    expect(statuses).deep.equals(['ready', 'unavailable'])
    act(() => {
      root.unmount()
    })
  })

  it('reports a refused or failed Android permission as denied', async function () {
    for (const request of [
      async () => 'denied',
      async () => {
        throw new Error('no activity')
      }
    ]) {
      const { scanner, drawn } = camera('android', request)
      const { statuses, root } = mount(scanner)
      await act(async () => {
        last(drawn).onStatus({ nativeEvent: { status: 'available' } })
      })
      expect(statuses).deep.equals(['denied'])
      expect(last(drawn).active).equals(false)
      act(() => {
        root.unmount()
      })
    }
  })

  it('asks nobody on a phone with no camera, and drops an answer after it closes', async function () {
    let answer: (value: string) => void = () => undefined
    const { scanner, drawn, asked } = camera(
      'android',
      async () => await new Promise<string>(resolve => (answer = resolve))
    )
    const quiet = mount(scanner)
    act(() => {
      last(drawn).onStatus({ nativeEvent: { status: 'unavailable' } })
    })
    expect(asked).deep.equals([])
    expect(quiet.statuses).deep.equals(['unavailable'])
    act(() => {
      quiet.root.unmount()
    })
    const late = mount(scanner)
    await act(async () => {
      last(drawn).onStatus({ nativeEvent: { status: 'available' } })
    })
    act(() => {
      late.root.unmount()
    })
    await act(async () => {
      answer('denied')
    })
    expect(late.statuses).deep.equals([])
  })

  it('asks Android once however often the sheet renders, and does not ask again after a refusal', async function () {
    let answer: (value: string) => void = () => undefined
    const { scanner, drawn, asked } = camera(
      'android',
      async () => await new Promise<string>(resolve => (answer = resolve))
    )
    const statuses: string[] = []
    const root = createRoot(document.createElement('div'))
    // As LineupShareSheet does, a new onStatus on every render.
    const render = (): void => {
      act(() => {
        root.render(
          createElement(scanner.QrScanner, {
            active: true,
            onCode: () => undefined,
            onStatus: (status: string) => statuses.push(status)
          })
        )
      })
    }
    render()
    await act(async () => {
      last(drawn).onStatus({ nativeEvent: { status: 'available' } })
    })
    render()
    render()
    expect(asked).has.length(1)
    await act(async () => {
      answer('granted')
    })
    expect(last(drawn).active).equals(true)
    act(() => {
      root.unmount()
    })
    const refused = camera('android', async () => 'never_ask_again')
    const second = mount(refused.scanner)
    await act(async () => {
      last(refused.drawn).onStatus({ nativeEvent: { status: 'available' } })
    })
    act(() => {
      second.root.render(
        createElement(refused.scanner.QrScanner, {
          active: true,
          onCode: () => undefined,
          onStatus: (status: string) => second.statuses.push(status)
        })
      )
    })
    expect(refused.asked).has.length(1)
    expect(second.statuses).deep.equals(['denied'])
    // Scan Again: the sheet turns the camera off for the warning, then on.
    for (const active of [false, true])
      await act(async () => {
        second.root.render(
          createElement(refused.scanner.QrScanner, {
            active,
            onCode: () => undefined,
            onStatus: (status: string) => second.statuses.push(status)
          })
        )
      })
    expect(second.statuses).deep.equals(['denied', 'denied'])
    expect(refused.asked).has.length(1)
    act(() => {
      second.root.unmount()
    })
  })

  it('starts the camera on Scan Again once it was allowed in Settings, and reads a code again', async function () {
    let allowedInSettings = false
    const { scanner, drawn, asked } = camera(
      'android',
      async () => 'denied',
      async () => allowedInSettings
    )
    const codes: string[] = []
    const root = createRoot(document.createElement('div'))
    const render = async (active: boolean): Promise<void> => {
      await act(async () => {
        root.render(
          createElement(scanner.QrScanner, {
            active,
            onCode: (text: string) => codes.push(text),
            onStatus: () => undefined
          })
        )
      })
    }
    await render(true)
    await act(async () => {
      last(drawn).onStatus({ nativeEvent: { status: 'available' } })
    })
    expect(last(drawn).active).equals(false)
    allowedInSettings = true
    await render(false)
    await render(true)
    expect(asked).has.length(1)
    expect(last(drawn).active).equals(true)
    // A code, a warning (the camera off), and the same code again.
    act(() => {
      last(drawn).onCode({ nativeEvent: { text: 'same' } })
    })
    await render(false)
    await render(true)
    act(() => {
      last(drawn).onCode({ nativeEvent: { text: 'same' } })
    })
    expect(codes).deep.equals(['same', 'same'])
    act(() => {
      root.unmount()
    })
  })

  it('lets iOS ask in the view, and keeps the camera off while inactive', async function () {
    const { scanner, drawn, asked } = camera('ios', async () => 'granted')
    const { root } = mount(scanner, false)
    act(() => {
      last(drawn).onStatus({ nativeEvent: { status: 'available' } })
    })
    expect(asked).deep.equals([])
    expect(last(drawn).active).equals(false)
    act(() => {
      root.render(
        createElement(scanner.QrScanner, {
          active: true,
          onCode: () => undefined,
          onStatus: () => undefined
        })
      )
    })
    expect(last(drawn).active).equals(true)
    act(() => {
      root.unmount()
    })
  })
})
