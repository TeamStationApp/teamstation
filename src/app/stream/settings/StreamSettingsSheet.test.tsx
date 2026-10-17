import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { LiveStream, TeamStationClient } from '../../../common/api'
import { HttpError } from '../../../common/errors'
import { ThemeProvider } from '../../theme/ThemeContext'
import {
  type FakePhoneStreamModule,
  fakePhoneStreamModule,
  RADAR_EVENT
} from '../fakePhoneStreamModule'
import type { NativePhoneLens, NativeRadarState } from '../NativePhoneStream'
import {
  makePhoneStream,
  type PermissionHost,
  type PhoneLens,
  type RadarDevice
} from '../phoneStreamClient'
import { StreamingScreen } from '../StreamingScreen.native'
import { radarRowParts, unbreakablePart } from './RadarCard'
import { cardColumns, settingsColumns } from './settingsLayout'
import {
  type AppliedSettings,
  lensLabel,
  lensToggleable,
  StreamSettingsSheet
} from './StreamSettingsSheet'

const LENSES: NativePhoneLens[] = [
  {
    id: 'lens-wide',
    position: 'back',
    title: '26 mm',
    subtitle: 'Back · 1x',
    displayedZoom: 1,
    focalLengthMM: 26,
    enabled: true,
    canDisable: true
  },
  {
    id: 'lens-tele',
    position: 'back',
    title: '77 mm',
    subtitle: 'Back · 3x',
    displayedZoom: 3,
    focalLengthMM: 77,
    enabled: true,
    canDisable: true
  }
]

const RADAR: NativeRadarState = {
  ...RADAR_EVENT,
  nearby: []
}

let root: Root | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)

/**
 * The props a React Native field was given, read off the rendered input's
 * fiber: the web renderer drops Android-only props such as
 * `disableFullscreenUI` from the DOM.
 */
function fieldProps(input: Element | null): Record<string, unknown> {
  const key = Object.keys(input ?? {}).find(name =>
    name.startsWith('__reactFiber$')
  )
  interface Fiber {
    memoizedProps?: Record<string, unknown>
    return?: Fiber
  }
  let fiber = (key == null ? undefined : (input as never)[key]) as
    Fiber | undefined
  while (fiber != null && fiber.memoizedProps?.onChangeText == null)
    fiber = fiber.return
  return fiber?.memoizedProps ?? {}
}

async function press(id: string): Promise<void> {
  await act(async () => {
    const node = byTestId(id)
    expect(node, id).not.equals(null)
    node!.click()
    await delay(20)
  })
}

/** A switch by its test id: react-native-web draws it as a checkbox inside. */
const switchOf = (id: string): HTMLInputElement =>
  document.querySelector<HTMLInputElement>(`[data-testid="${id}"] input`)!

async function flip(id: string): Promise<void> {
  await act(async () => {
    switchOf(id).click()
    await delay(20)
  })
}

async function type(id: string, value: string): Promise<void> {
  await act(async () => {
    const input = document.querySelector<HTMLInputElement>(
      `[data-testid="${id}"]`
    )!
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
    await delay(10)
  })
}

/** The window react-native-web reports, as a phone turned this way would. */
async function setWindow(width: number, height: number): Promise<void> {
  await act(async () => {
    const page = document.documentElement
    Object.defineProperty(page, 'clientWidth', {
      configurable: true,
      value: width
    })
    Object.defineProperty(page, 'clientHeight', {
      configurable: true,
      value: height
    })
    window.dispatchEvent(new window.Event('resize'))
    await delay(10)
  })
}

/** How many columns of cards the sheet shows. */
const columnsShown = (): number =>
  byTestId('settings-audio-card')!.parentElement!.parentElement!.children.length

const calls = (native: FakePhoneStreamModule, name: string): unknown[][] =>
  native.calls.filter(call => call.name === name).map(call => call.args)

interface Harness {
  native: FakePhoneStreamModule
  patches: Array<{ gameId: string; streamId: string; change: unknown }>
  done: AppliedSettings[]
  renamed: string[]
  cancels: number
  rotations: string[]
  ios: string[]
  /** What the next PATCH throws. */
  refuse?: Error
}

async function mountSheet(
  options: {
    answers?: Record<string, unknown>
    radar?: NativeRadarState | null
    audioEnabled?: boolean
    permissions?: PermissionHost
  } = {}
): Promise<Harness> {
  const native = fakePhoneStreamModule({
    lenses: LENSES,
    radarPair: true,
    ...options.answers
  })
  const h: Harness = {
    native,
    patches: [],
    done: [],
    renamed: [],
    cancels: 0,
    rotations: [],
    ios: []
  }
  const client = {
    updateLiveStream: async (
      gameId: string,
      streamId: string,
      change: { label?: string }
    ): Promise<LiveStream> => {
      h.patches.push({ gameId, streamId, change })
      if (h.refuse != null) throw h.refuse
      return { label: change.label ?? '' } as unknown as LiveStream
    }
  } as unknown as TeamStationClient
  const phone = makePhoneStream(native, options.permissions)
  const radar = options.radar === undefined ? RADAR : options.radar
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const render = (state: NativeRadarState | null): void => {
    root!.render(
      <ThemeProvider>
        <StreamSettingsSheet
          client={client}
          gameId="gam_1"
          streamId="liv_00000000000000000001"
          angleName="Home Plate"
          audioEnabled={options.audioEnabled ?? true}
          phone={phone}
          radar={
            state == null
              ? null
              : {
                  ...state,
                  bluetooth: state.bluetooth === 'off' ? 'off' : 'on',
                  devices: state.devices.map(device => ({
                    serial: device.serial,
                    connection: device.connection,
                    batteryPercent: device.batteryPercent ?? null,
                    pitchMph: device.pitchMph ?? null,
                    exitMph: device.exitMph ?? null,
                    readingAt: device.readingAt ?? null
                  })),
                  nearby: [...state.nearby]
                }
          }
          rotation={{
            allow: () => h.rotations.push('any'),
            lockLandscape: () => h.rotations.push('landscape')
          }}
          cameraOrientation={{
            any: () => h.ios.push('any'),
            landscape: () => h.ios.push('landscape')
          }}
          onRenamed={name => h.renamed.push(name)}
          onDone={applied => h.done.push(applied)}
          onCancel={() => {
            h.cancels += 1
          }}
        />
      </ThemeProvider>
    )
  }
  rerender = async state => {
    await act(async () => {
      render(state)
      await delay(20)
    })
  }
  await act(async () => {
    render(radar)
    await delay(20)
  })
  return h
}

let rerender: (state: NativeRadarState | null) => Promise<void> = async () => {}

const DEVICE: RadarDevice = {
  serial: 'TAG-00000001',
  connection: 'connected',
  batteryPercent: 80,
  pitchMph: 54,
  exitMph: null,
  readingAt: 1_790_000_000_000
}

describe('the stream settings sheet', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
      await delay(10)
    })
    root = undefined
  })

  it('lays the cards out in two columns only in landscape at 600 wide or more', function () {
    expect(settingsColumns(599, 390)).equals(1)
    expect(settingsColumns(600, 390)).equals(2)
    expect(settingsColumns(844, 390)).equals(2)
    expect(settingsColumns(390, 844)).equals(1)
    expect(settingsColumns(700, 1000)).equals(1)
    expect(cardColumns(['a', 'b', 'c', 'd'], 2)).deep.equals([
      ['a', 'b'],
      ['c', 'd']
    ])
    expect(cardColumns(['a', 'b', 'c'], 2)).deep.equals([['a', 'b'], ['c']])
    expect(cardColumns(['a', 'b'], 1)).deep.equals([['a', 'b']])
  })

  it('shows Audio, Lenses, Name and Radar in that order, and none of Cameraman’s other settings', async function () {
    await setWindow(844, 390)
    const h = await mountSheet()
    expect(byTestId('settings-layout-landscape')).not.equals(null)
    expect(columnsShown()).equals(2)
    const sheet = byTestId('settings-layout-landscape')!
    const titles = [
      'settings-audio-card',
      'settings-lenses-card',
      'settings-name-card',
      'settings-radar'
    ].map(id => byTestId(id)!.firstElementChild!.textContent)
    expect(titles).deep.equals(['AUDIO', 'LENSES', 'NAME', 'RADAR'])
    const order = [
      ...sheet.querySelectorAll(
        '[data-testid$="-card"], [data-testid="settings-radar"]'
      )
    ].map(node => node.getAttribute('data-testid'))
    expect(order).deep.equals([
      'settings-audio-card',
      'settings-lenses-card',
      'settings-name-card',
      'settings-radar'
    ])
    const text = sheet.textContent ?? ''
    expect(text).contains('Camera')
    expect(text).contains('Done')
    for (const absent of [
      'Bitrate',
      'Codec',
      'Resolution',
      'Clean HDMI',
      'Identifier',
      'Log in',
      'Scoreboard',
      'Test thermal',
      'Address'
    ])
      expect(text, absent).not.contains(absent)
    expect(h.rotations).deep.equals(['any'])
    expect(h.ios).deep.equals(['any'])
    // A tall window is one column; landscape narrower than 600, one column.
    await setWindow(390, 844)
    expect(byTestId('settings-layout-portrait')).not.equals(null)
    expect(columnsShown()).equals(1)
    await setWindow(599, 390)
    expect(columnsShown()).equals(1)
    await setWindow(0, 0)
    await act(async () => {
      root?.unmount()
      await delay(10)
    })
    root = undefined
    expect(h.rotations).deep.equals(['any', 'landscape'])
    expect(h.ios).deep.equals(['any', 'landscape'])
  })

  it('renames the angle on the server and in the engine with Done', async function () {
    const h = await mountSheet()
    // Held sideways, an Android phone edits the name in place.
    expect(fieldProps(byTestId('settings-name')).disableFullscreenUI).equals(
      true
    )
    await type('settings-name', '  Third Base ')
    await press('settings-done')
    expect(h.patches).deep.equals([
      {
        gameId: 'gam_1',
        streamId: 'liv_00000000000000000001',
        change: { label: 'Third Base' }
      }
    ])
    expect(calls(h.native, 'setAngleName')).deep.equals([['Third Base']])
    expect(h.renamed).deep.equals(['Third Base'])
    expect(h.done).deep.equals([
      { angleName: 'Third Base', audioEnabled: true }
    ])
    // Nothing else changed, so nothing else was sent.
    expect(calls(h.native, 'setAudioEnabled')).deep.equals([])
    expect(calls(h.native, 'setDisabledLenses')).deep.equals([])
  })

  it('shows the server’s refusal under the name and keeps the old one', async function () {
    const h = await mountSheet()
    h.refuse = new HttpError(
      'conflict',
      'You already have a camera called First Base on this game'
    )
    await type('settings-name', 'First Base')
    await flip('settings-audio')
    await press('settings-done')
    expect(byTestId('settings-name-error')?.textContent).equals(
      'You already have a camera called First Base on this game'
    )
    expect(calls(h.native, 'setAngleName')).deep.equals([])
    expect(calls(h.native, 'setAudioEnabled')).deep.equals([])
    expect(h.renamed).deep.equals([])
    expect(h.done).deep.equals([])
    // Typing again clears it; a name the rules refuse is said at once and not sent.
    await type('settings-name', 'Left — Field')
    expect(byTestId('settings-name-error')?.textContent).equals(
      'A camera name cannot contain " — ".'
    )
    await press('settings-done')
    expect(h.patches).has.length(1)
    // A blank name keeps the one there is.
    h.refuse = undefined
    await type('settings-name', '   ')
    expect(byTestId('settings-name-error')).equals(null)
    await press('settings-done')
    expect(h.patches).has.length(1)
    expect(h.done).deep.equals([
      { angleName: 'Home Plate', audioEnabled: false }
    ])
  })

  it('turns the microphone and the lenses as set, with Done', async function () {
    const h = await mountSheet()
    expect(
      [
        ...document.querySelectorAll<HTMLElement>(
          '[data-testid="settings-lenses-card"] input'
        )
      ].map(input => input.getAttribute('aria-label'))
    ).deep.equals(['26 mm · Back', '77 mm · Back'])
    await flip('settings-audio')
    await flip('settings-lens-1')
    // The one lens left on cannot be turned off.
    expect(switchOf('settings-lens-0').disabled).equals(true)
    expect(switchOf('settings-lens-1').checked).equals(false)
    await press('settings-done')
    expect(calls(h.native, 'setAudioEnabled')).deep.equals([[false]])
    expect(calls(h.native, 'setDisabledLenses')).deep.equals([[['lens-tele']]])
    expect(h.done).deep.equals([
      { angleName: 'Home Plate', audioEnabled: false }
    ])
  })

  it('says when there is one lens, and when the engine refuses a change', async function () {
    const h = await mountSheet({ answers: { lenses: [] } })
    expect(byTestId('settings-lenses-card')?.textContent).contains(
      'This camera has one lens.'
    )
    h.native.failures.setAudioEnabled = {
      code: 'notReady',
      message: 'not ready'
    }
    await flip('settings-audio')
    await press('settings-done')
    expect(byTestId('settings-name-error')?.textContent).equals('not ready')
    expect(h.done).deep.equals([])
  })

  it('decides which lens switches may move', function () {
    const lenses: PhoneLens[] = LENSES.map(lens => ({
      ...lens,
      position: 'back',
      focalLengthMM: lens.focalLengthMM ?? null
    }))
    expect(lensToggleable(lenses[0], lenses, new Set())).equals(true)
    expect(lensToggleable(lenses[0], lenses, new Set(['lens-tele']))).equals(
      false
    )
    expect(lensToggleable(lenses[1], lenses, new Set(['lens-tele']))).equals(
      true
    )
    expect(lensLabel({ ...lenses[0], position: 'front' })).equals(
      '26 mm · Front'
    )
  })

  it('words a radar’s row, with a dash for a speed it has not read', function () {
    expect(
      radarRowParts(DEVICE)
        .map(part => part.text)
        .join('')
    ).equals(' · Connected · ⚡80% · 54 / – mph')
    expect(
      radarRowParts({
        ...DEVICE,
        connection: 'scanning',
        batteryPercent: null,
        pitchMph: null,
        exitMph: 88.6
      })
        .map(part => part.text)
        .join('')
    ).equals(' · – / 89 mph')
    expect(radarRowParts(DEVICE)[0].connected).equals(true)
  })

  it('wraps a long radar row between its parts instead of cutting it off, Unpair on the right', async function () {
    expect(unbreakablePart(' · 54 / – mph')).equals(
      ' ·\u00a054\u00a0/\u00a0–\u00a0mph'
    )
    expect(unbreakablePart('⚡80%')).equals('⚡80%')
    await mountSheet({
      radar: {
        ...RADAR,
        devices: [
          {
            ...DEVICE,
            serial: 'TAG-0000000000000000000000000001',
            batteryPercent: 100,
            pitchMph: 101.4,
            exitMph: 112.6,
            readingAt: undefined
          }
        ]
      }
    })
    const serial = 'TAG-0000000000000000000000000001'
    const text = byTestId(`settings-radar-device-text-${serial}`)!
    // The whole row is there, battery and speeds included, with no ellipsis.
    expect(text.textContent).equals(
      `${serial} ·\u00a0Connected ·\u00a0⚡100% ·\u00a0101\u00a0/\u00a0113\u00a0mph`
    )
    const style = getComputedStyle(text)
    expect(style.textOverflow).not.equals('ellipsis')
    expect(style.whiteSpace).not.equals('nowrap')
    expect(style.getPropertyValue('-webkit-line-clamp')).equals('')
    // Unpair follows the text in the row, so it sits on the right.
    const row = byTestId(`settings-radar-device-${serial}`)!
    expect(row.lastElementChild?.getAttribute('data-testid')).equals(
      `settings-radar-unpair-${serial}`
    )
  })

  it('lists each paired radar with Unpair, and Pair Device last', async function () {
    const h = await mountSheet()
    const card = byTestId('settings-radar')!
    expect(card.textContent).contains(
      'Track pitch speed and exit velocity with Tag Sports Radar.'
    )
    expect(switchOf('settings-radar-enabled').checked).equals(true)
    expect(
      byTestId('settings-radar-device-TAG-00000001')?.textContent?.replace(
        /\u00a0/g,
        ' '
      )
    ).equals('TAG-00000001 · Connected · ⚡80% · 54 / – mphUnpair')
    const pressables = [
      ...card.querySelectorAll<HTMLElement>('[data-testid^="settings-radar-"]')
    ].map(node => node.getAttribute('data-testid'))
    expect(pressables.at(-1)).equals('settings-radar-pair')
    expect(byTestId('settings-radar-pair')?.textContent).contains('Pair Device')
    await press('settings-radar-unpair-TAG-00000001')
    expect(calls(h.native, 'radarUnpair')).deep.equals([['TAG-00000001']])
    // The engine reports it gone; Pair Device is still last.
    await rerender({ ...RADAR, devices: [] })
    expect(byTestId('settings-radar-device-TAG-00000001')).equals(null)
    expect(byTestId('settings-radar-pair')).not.equals(null)
  })

  it('says why Unpair failed, and that Bluetooth is off', async function () {
    const h = await mountSheet({ radar: { ...RADAR, bluetooth: 'off' } })
    expect(byTestId('settings-radar')?.textContent).contains('Bluetooth is off')
    h.native.failures.radarUnpair = { code: 'notReady', message: 'not ready' }
    await press('settings-radar-unpair-TAG-00000001')
    expect(byTestId('settings-radar-problem')?.textContent).equals('not ready')
  })

  it('opens the picker from Pair Device: it scans, lists, pairs and closes', async function () {
    const h = await mountSheet()
    await press('settings-radar-pair')
    expect(byTestId('pair-device-modal')).not.equals(null)
    expect(calls(h.native, 'radarScan')).has.length(1)
    expect(byTestId('pair-device-empty')?.textContent).equals(
      'No radars in range'
    )
    await rerender({ ...RADAR, scanning: true, nearby: ['TAG-00000002'] })
    expect(byTestId('pair-device-empty')).equals(null)
    await press('pair-device-TAG-00000002')
    expect(calls(h.native, 'radarPair')).deep.equals([['TAG-00000002']])
    expect(byTestId('pair-device-modal')).equals(null)
    expect(calls(h.native, 'radarStopScan')).has.length(1)
  })

  it('stops the scan on Close, and says when a radar would not pair', async function () {
    const h = await mountSheet({
      answers: { radarPair: false },
      radar: { ...RADAR, nearby: ['TAG-00000002'] }
    })
    await press('settings-radar-pair')
    await press('pair-device-TAG-00000002')
    expect(byTestId('pair-device-problem')?.textContent).equals(
      'Could not pair TAG-00000002'
    )
    h.native.failures.radarPair = { code: 'notReady', message: 'not ready' }
    await press('pair-device-TAG-00000002')
    expect(byTestId('pair-device-problem')?.textContent).equals('not ready')
    expect(calls(h.native, 'radarStopScan')).has.length(0)
    await press('pair-device-close')
    expect(byTestId('pair-device-modal')).equals(null)
    expect(calls(h.native, 'radarStopScan')).has.length(1)
  })

  it('says why the picker cannot scan', async function () {
    const h = await mountSheet()
    h.native.failures.radarScan = { code: 'notReady', message: 'not ready' }
    await press('settings-radar-pair')
    expect(byTestId('pair-device-problem')?.textContent).equals('not ready')
  })

  it('turns the radar on and off, asking Android for Bluetooth first', async function () {
    const asked: string[][] = []
    let grant = true
    const h = await mountSheet({
      radar: { ...RADAR, enabled: false, devices: [] },
      permissions: {
        androidApi: 34,
        request: async wanted => {
          asked.push(wanted)
          return grant
        }
      }
    })
    expect(switchOf('settings-radar-enabled').checked).equals(false)
    await flip('settings-radar-enabled')
    expect(asked).deep.equals([
      [
        'android.permission.BLUETOOTH_SCAN',
        'android.permission.BLUETOOTH_CONNECT'
      ]
    ])
    expect(calls(h.native, 'radarSetEnabled')).deep.equals([[true]])
    grant = false
    await flip('settings-radar-enabled')
    expect(byTestId('settings-radar-problem')?.textContent).equals(
      'Allow Bluetooth for TeamStation in Settings to use a radar.'
    )
    expect(calls(h.native, 'radarSetEnabled')).has.length(1)
    // Refused, Pair Device does not open the picker.
    await press('settings-radar-pair')
    expect(byTestId('pair-device-modal')).equals(null)
    // Granted, Pair Device turns the radar on and opens it.
    grant = true
    await press('settings-radar-pair')
    expect(calls(h.native, 'radarSetEnabled')).deep.equals([[true], [true]])
    expect(byTestId('pair-device-modal')).not.equals(null)
    h.native.failures.radarSetEnabled = 'gone'
    await rerender({ ...RADAR, enabled: true, devices: [] })
    await press('pair-device-close')
    await flip('settings-radar-enabled')
    expect(byTestId('settings-radar-problem')?.textContent).equals('gone')
  })
})

describe('the streaming screen’s settings', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
      await delay(10)
    })
    root = undefined
  })

  it('opens from the gear, and the badge follows a rename', async function () {
    const native = fakePhoneStreamModule({
      lenses: LENSES,
      zoomScale: {
        presets: [1],
        switchOvers: [],
        minimum: 1,
        maximum: 1,
        current: 1
      },
      radarState: { ...RADAR, devices: [] }
    })
    const patches: unknown[] = []
    const client = {
      baseUrl: 'https://teamstation.example.test/api/v1',
      token: 'token-0000',
      updateLiveStream: async (
        _gameId: string,
        _streamId: string,
        change: { label?: string }
      ): Promise<LiveStream> => {
        patches.push(change)
        return { label: change.label } as unknown as LiveStream
      }
    } as unknown as TeamStationClient
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <StreamingScreen
            client={client}
            session={{
              gameId: 'gam_1',
              streamId: 'liv_00000000000000000001',
              url: 'rtmp://ingest.example.test:1936/live/ts_00000000000000000000',
              angleName: 'Home Plate'
            }}
            deviceId="00000000-0000-4000-8000-000000000001"
            deviceModel="iPhone 13 Pro"
            phone={makePhoneStream(native)}
            rotation={{ lockLandscape: () => {}, restore: () => {} }}
            openScoreboardSocket={() => {
              throw new Error('no radar is paired')
            }}
            onClose={() => {}}
          />
        </ThemeProvider>
      )
      await delay(20)
    })
    await press('settings-button')
    await type('settings-name', 'Third Base')
    await flip('settings-audio')
    await press('settings-done')
    expect(patches).deep.equals([{ label: 'Third Base' }])
    expect(byTestId('settings-done')).equals(null)
    expect(byTestId('camera-name')?.textContent).equals('Third Base')
    // The sheet opens again on what Done applied, and records under the new name.
    await press('settings-button')
    expect(switchOf('settings-audio').checked).equals(false)
    expect(
      document.querySelector<HTMLInputElement>('[data-testid="settings-name"]')
        ?.value
    ).equals('Third Base')
    // Done with nothing changed applies nothing.
    await press('settings-done')
    expect(byTestId('settings-done')).equals(null)
    expect(
      native.calls.filter(call => call.name === 'setAudioEnabled')
    ).has.length(1)
    await press('broadcast-button')
    expect(
      native.calls.find(call => call.name === 'startRecording')?.args[3]
    ).equals('Third Base')
  })
})
