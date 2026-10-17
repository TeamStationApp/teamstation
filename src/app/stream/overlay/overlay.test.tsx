import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AccessibilityInfo, type GestureResponderEvent } from 'react-native'

import type { PhoneStreamStatus, RadarState } from '../phoneStreamClient'
import { BatteryBadge, batteryColor, batteryLabel } from './BatteryBadge'
import { NameBadge } from './NameBadge'
import { OverlayButton } from './OverlayButton'
import {
  BATTERY,
  ENDED_RED,
  IDLE_BLUE,
  PULSE_BRIGHT,
  PULSE_DARK
} from './overlayTheme'
import { RadarReadout, radarReadout } from './RadarReadout'
import { RecordButton } from './RecordButton'
import {
  SLIDE_TRAVEL,
  slideCommits,
  slideGesture,
  slideResponder,
  SlideToStop
} from './SlideToStop'
import { pillFor, StreamStatusPill } from './StreamStatusPill'
import { showsFlames, ThermalBadge, thermalLabel } from './ThermalBadge'
import type { RailBand } from './zoomGestures'
import { type Measurable, measureRail, ZoomScale } from './ZoomScale'

// eslint-disable-next-line @typescript-eslint/unbound-method -- kept to be put back
const reduceMotion = AccessibilityInfo.isReduceMotionEnabled
let root: Root | undefined
let host: HTMLElement | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function render(
  element: React.ReactElement,
  still = false
): Promise<HTMLElement> {
  AccessibilityInfo.isReduceMotionEnabled = async () => still
  if (root == null) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(element)
    await delay(10)
  })
  return host!
}

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`)

const STATUS: PhoneStreamStatus = {
  phase: 'idle',
  retryInSeconds: null,
  bitrateKbps: 0,
  displayedZoom: 1,
  lensLabel: '1x',
  batteryPercent: 64,
  charging: false,
  thermal: 'cool',
  recordingSeconds: 0,
  isRecording: false,
  error: null
}

/** A colour as the browser writes it back, for `#RRGGBB`. */
function rgb(hex: string): string {
  const value = Number.parseInt(hex.slice(1), 16)
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`
}

describe('the streaming overlay', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    host = undefined
    AccessibilityInfo.isReduceMotionEnabled = reduceMotion
  })

  it('names the angle in the badge', async function () {
    await render(<NameBadge name="Home Plate" />)
    expect(byTestId('camera-name')?.textContent).equals('Home Plate')
  })

  it('says what the stream is doing, in the pill’s words and colours', async function () {
    expect(pillFor(null)).deep.equals({
      kind: 'idle',
      text: 'Press record to start stream',
      color: IDLE_BLUE
    })
    expect(pillFor({ ...STATUS, isRecording: true })).to.include({
      kind: 'connecting',
      text: 'Connecting'
    })
    expect(pillFor({ ...STATUS, phase: 'connecting' }).kind).equals(
      'connecting'
    )
    expect(
      pillFor({ ...STATUS, phase: 'retrying', retryInSeconds: 6 })
    ).deep.equals({
      kind: 'connecting',
      text: 'Connecting',
      colors: [PULSE_DARK, PULSE_BRIGHT]
    })
    expect(pillFor({ ...STATUS, phase: 'live' })).deep.equals({
      kind: 'live',
      text: 'Broadcasting',
      colors: [PULSE_DARK, PULSE_BRIGHT]
    })
    expect(
      pillFor({
        ...STATUS,
        phase: 'idle',
        isRecording: true,
        error: 'streamEnded'
      })
    ).deep.equals({ kind: 'ended', text: 'Stream ended', color: ENDED_RED })

    await render(<StreamStatusPill status={STATUS} />)
    let pill = byTestId('stream-status-pill')!
    expect(pill.textContent).equals('Press record to start stream')
    expect(pill.style.backgroundColor).equals(rgb(IDLE_BLUE))
    await render(
      <StreamStatusPill status={{ ...STATUS, error: 'streamEnded' }} />
    )
    pill = byTestId('stream-status-pill')!
    expect(pill.textContent).equals('Stream ended')
    expect(pill.style.backgroundColor).equals(rgb(ENDED_RED))
    await render(<StreamStatusPill status={{ ...STATUS, phase: 'live' }} />)
    pill = byTestId('stream-status-pill')!
    expect(pill.textContent).equals('Broadcasting')
    // The white square goes before the word while live, and only then.
    expect(pill.childElementCount).equals(2)
    await render(
      <StreamStatusPill status={{ ...STATUS, phase: 'connecting' }} />,
      true
    )
    pill = byTestId('stream-status-pill')!
    expect(pill.textContent).equals('Connecting')
    expect(pill.childElementCount).equals(1)
  })

  it('shows the four heat levels, with flames for Hot', async function () {
    expect(
      ['cool', 'fair', 'warm', 'hot'].map(level =>
        thermalLabel(level as 'cool')
      )
    ).deep.equals(['COOL', 'FAIR', 'WARM', 'HOT'])
    expect(showsFlames('warm')).equals(false)
    expect(showsFlames('hot')).equals(true)
    await render(<ThermalBadge level="warm" />)
    expect(byTestId('camera-thermal')?.textContent).equals('WARM')
    await render(<ThermalBadge level="hot" />)
    expect(byTestId('camera-thermal')?.textContent).equals('🔥HOT🔥')
    await render(<ThermalBadge level="hot" />, true)
    expect(byTestId('camera-thermal')?.textContent).equals('🔥HOT🔥')
    await render(<ThermalBadge level="fair" />, true)
    expect(byTestId('camera-thermal')?.textContent).equals('FAIR')
  })

  it('turns the battery yellow below 20 %, with a bolt while it charges', async function () {
    expect(batteryColor(20)).equals(BATTERY.green)
    expect(batteryColor(19)).equals(BATTERY.low)
    expect(batteryLabel(64.4)).equals('64%')
    expect(batteryLabel(140)).equals('100%')
    await render(<BatteryBadge percent={19} charging={false} />)
    const badge = byTestId('camera-battery')!
    // The unseen widest label holds the width; the shown one follows it.
    expect(badge.textContent).equals('100%19%')
    expect(
      (badge.firstElementChild as HTMLElement).style.backgroundColor
    ).equals(rgb(BATTERY.low))
    expect(byTestId('camera-battery-bolt')).not.equals(null)
    expect(
      document.querySelectorAll('[data-testid="camera-battery-bolt"]')
    ).has.length(1)
    await render(<BatteryBadge percent={85} charging />)
    expect(
      (byTestId('camera-battery')!.firstElementChild as HTMLElement).style
        .backgroundColor
    ).equals(rgb(BATTERY.green))
    expect(
      document.querySelectorAll('[data-testid="camera-battery-bolt"]')
    ).has.length(2)
  })

  it('draws the zoom rail from zoomScale(), lights the active pill, and selects one', async function () {
    const selected: number[] = []
    const rails: Array<[number, number, number]> = []
    const scale = {
      presets: [0.5, 1, 3, 9, 18],
      switchOvers: [1, 3],
      digitalFrom: 9,
      minimum: 0.5,
      maximum: 18,
      current: 1
    }
    await render(
      <ZoomScale
        scale={scale}
        displayed={1}
        onSelect={value => selected.push(value)}
      />
    )
    const pills = [
      ...document.querySelectorAll<HTMLElement>('[data-testid^="zoom-preset-"]')
    ]
    expect(pills.map(pill => pill.textContent)).deep.equals([
      '18x',
      '9x',
      '3x',
      '1x',
      '0.5x'
    ])
    expect(pills.map(pill => pill.getAttribute('aria-selected'))).deep.equals([
      'false',
      'false',
      'false',
      'true',
      'false'
    ])
    expect(byTestId('zoom-label')?.textContent).equals('1x')
    expect(document.querySelectorAll('[data-testid^="zoom-tick-"]')).has.length(
      20
    )
    await act(async () => {
      byTestId('zoom-preset-3x')!.click()
      await delay(10)
    })
    expect(selected).deep.equals([3])
    // Between two pills, a tick lights instead; past 3x the readout is yellow.
    await render(<ZoomScale scale={scale} displayed={6} onSelect={() => {}} />)
    expect(byTestId('zoom-tick-2-2')?.getAttribute('aria-selected')).equals(
      'true'
    )
    expect(byTestId('zoom-label')?.style.color).equals('rgb(255, 214, 10)')
    // The rail's band and its pill-to-pill gap, from where it was laid out.
    const view = (y: number, height: number): Measurable => ({
      measureInWindow: report => {
        report(800, y, 32, height)
      }
    })
    measureRail(
      view(24, 320),
      () => 5,
      (band, gap) => {
        rails.push([band.top, band.bottom, gap])
      }
    )
    measureRail(
      view(24, 320),
      () => 1,
      (band, gap) => {
        rails.push([band.top, band.bottom, gap])
      }
    )
    measureRail(
      null,
      () => 5,
      () => {
        rails.push([0, 0, 0])
      }
    )
    // Asked from a render with one pill, measured once the rail holds five:
    // the gap is the five-pill rail's.
    let laidOut = 1
    let report: (() => void) | undefined
    measureRail(
      {
        measureInWindow: done => {
          report = () => {
            done(800, 24, 32, 320)
          }
        }
      },
      () => laidOut,
      (band, gap) => {
        rails.push([band.top, band.bottom, gap])
      }
    )
    laidOut = 5
    report?.()
    expect(rails).deep.equals([
      [24, 344, 72],
      [24, 344, 0],
      [24, 344, 72]
    ])
    await render(
      <ZoomScale
        scale={{
          ...scale,
          presets: [1],
          minimum: 1,
          maximum: 1,
          switchOvers: []
        }}
        displayed={1}
        onSelect={() => {}}
      />
    )
    expect(byTestId('zoom-preset-1x')?.getAttribute('aria-selected')).equals(
      'true'
    )
  })

  it('measures the rail again when the camera reports its lenses, though its frame stays', async function () {
    // jsdom lays nothing out: every view reads as the rail, 320 tall at 24.
    const prototype = HTMLElement.prototype
    // eslint-disable-next-line @typescript-eslint/unbound-method -- kept to be put back
    const rect = prototype.getBoundingClientRect
    prototype.getBoundingClientRect = () =>
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      ({ x: 800, y: 24, left: 800, top: 24, width: 32, height: 320 }) as DOMRect
    try {
      const rails: Array<[number, number, number]> = []
      const onRail = (band: RailBand, gap: number): void => {
        rails.push([band.top, band.bottom, gap])
      }
      const lens = {
        presets: [1],
        switchOvers: [],
        digitalFrom: null,
        minimum: 1,
        maximum: 1,
        current: 1
      }
      await render(
        <ZoomScale
          scale={lens}
          displayed={1}
          onSelect={() => {}}
          onRail={onRail}
        />
      )
      // The measurement comes back on a timer after the effect asks for it.
      const measured = async (): Promise<void> => {
        await act(async () => {
          await delay(20)
        })
      }
      await measured()
      expect(rails.at(-1)).deep.equals([24, 344, 0])
      await render(
        <ZoomScale
          scale={{
            presets: [0.5, 1, 3, 9, 18],
            switchOvers: [1, 3],
            digitalFrom: 9,
            minimum: 0.5,
            maximum: 18,
            current: 1
          }}
          displayed={1}
          onSelect={() => {}}
          onRail={onRail}
        />
      )
      await measured()
      expect(rails.at(-1)).deep.equals([24, 344, 72])
    } finally {
      prototype.getBoundingClientRect = rect
    }
  })

  it('records with one tap and stops only with a slide past 80 %', async function () {
    expect(slideCommits(0.8)).equals(true)
    expect(slideCommits(0.79)).equals(false)
    const offsets: number[] = []
    let stops = 0
    const gesture = slideGesture(
      offset => offsets.push(offset),
      () => {
        stops += 1
      },
      100
    )
    gesture.start(10)
    gesture.move(89)
    gesture.end()
    expect(stops).equals(0)
    expect(offsets).deep.equals([79, 0])
    gesture.start(10)
    gesture.move(-50)
    gesture.move(90)
    gesture.end()
    expect(stops).equals(1)
    expect(offsets.slice(2)).deep.equals([0, 80, 100])
    // Nothing moves or ends without a finger down.
    gesture.move(50)
    gesture.end()
    expect(offsets).has.length(5)

    const pressed: string[] = []
    await render(
      <RecordButton recording={false} onPress={() => pressed.push('idle')} />
    )
    const button = byTestId('broadcast-button')!
    expect(button.getAttribute('aria-label')).equals('Start recording')
    expect(button.style.backgroundColor).equals('rgb(140, 59, 64)')
    await act(async () => {
      button.click()
      await delay(10)
    })
    await render(
      <RecordButton recording onPress={() => pressed.push('live')} />
    )
    expect(byTestId('broadcast-button')!.style.backgroundColor).equals(
      'rgb(242, 61, 71)'
    )
    expect(byTestId('broadcast-button')!.getAttribute('aria-label')).equals(
      'Stop recording'
    )
    expect(pressed).deep.equals(['idle'])
  })

  it('slides the knob with the finger and stops at 80 % of the way', async function () {
    let stopped = 0
    await render(
      <SlideToStop
        onStop={() => {
          stopped += 1
        }}
      />
    )
    expect(byTestId('slide-to-stop-label')?.textContent).equals('Slide to Stop')
    const at = (x: number): GestureResponderEvent =>
      ({ nativeEvent: { pageX: x } }) as unknown as GestureResponderEvent
    const props = slideResponder(
      slideGesture(
        () => {},
        () => {
          stopped += 1
        }
      )
    )
    expect(props.onStartShouldSetResponder()).equals(true)
    expect(props.onMoveShouldSetResponder()).equals(true)
    expect(props.onResponderTerminationRequest()).equals(false)
    props.onResponderGrant(at(0))
    props.onResponderMove(at(Math.ceil(SLIDE_TRAVEL * 0.79)))
    props.onResponderTerminate()
    expect(stopped).equals(0)
    props.onResponderGrant(at(0))
    props.onResponderMove(at(Math.ceil(SLIDE_TRAVEL * 0.8)))
    props.onResponderRelease()
    expect(stopped).equals(1)
    await render(<SlideToStop onStop={() => {}} />, true)
    expect(byTestId('slide-to-stop-knob')).not.equals(null)
  })

  it('shows the radar’s battery and speeds, a dash once a reading is old', async function () {
    const now = 1_790_000_010_000
    const radar: RadarState = {
      enabled: true,
      scanning: false,
      bluetooth: 'on',
      devices: [
        {
          serial: 'TAG-00000002',
          connection: 'connecting',
          batteryPercent: 40,
          pitchMph: 60,
          exitMph: null,
          readingAt: now - 1000
        },
        {
          serial: 'TAG-00000001',
          connection: 'connected',
          batteryPercent: 85,
          pitchMph: 71.6,
          exitMph: null,
          readingAt: now - 1000
        }
      ],
      nearby: []
    }
    expect(radarReadout(radar, now)).equals('⚡85% 72/–')
    expect(radarReadout(radar, now + 5000)).equals('⚡85% –/–')
    expect(
      radarReadout(
        {
          ...radar,
          devices: [
            { ...radar.devices[1], batteryPercent: null, exitMph: 88 },
            { ...radar.devices[1], serial: 'TAG-00000003', readingAt: null }
          ]
        },
        now
      )
    ).equals('72/88')
    expect(
      radarReadout(
        { ...radar, devices: [{ ...radar.devices[0], readingAt: null }] },
        now
      )
    ).equals('⚡40% –/–')
    expect(radarReadout({ ...radar, devices: [] }, now)).equals(null)
    expect(radarReadout({ ...radar, enabled: false }, now)).equals(null)
    expect(radarReadout(null, now)).equals(null)

    const realSetInterval = globalThis.setInterval
    let tick: (() => void) | undefined
    globalThis.setInterval = ((callback: () => void) => {
      tick = callback
      return 0
    }) as unknown as typeof setInterval
    let clock = now
    try {
      await render(
        <RadarReadout radar={radar} bottom={21} right={47} now={() => clock} />
      )
      const readout = byTestId('radar-speeds')!
      expect(readout.textContent).equals('⚡85% 72/–')
      expect(readout.style.bottom).equals('45px')
      expect(readout.style.right).equals('113px')
      clock = now + 6000
      await act(async () => {
        tick?.()
        await delay(10)
      })
      expect(byTestId('radar-speeds')!.textContent).equals('⚡85% –/–')
    } finally {
      globalThis.setInterval = realSetInterval
    }
    await render(<RadarReadout radar={null} bottom={0} right={0} />)
    expect(byTestId('radar-speeds')).equals(null)
  })

  it('draws the round buttons, glyph or not, and holds a disabled one', async function () {
    const pressed: string[] = []
    await render(
      <>
        <OverlayButton
          glyph="close"
          testID="camera-close"
          accessibilityLabel="Close camera"
          disabled
          onPress={() => pressed.push('close')}
        />
        <OverlayButton
          glyph="flip"
          testID="flip-button"
          accessibilityLabel="Flip camera"
          onPress={() => pressed.push('flip')}
        />
      </>
    )
    await act(async () => {
      byTestId('camera-close')!.click()
      byTestId('flip-button')!.click()
      await delay(10)
    })
    expect(pressed).deep.equals(['flip'])
    expect(byTestId('camera-close')!.getAttribute('aria-disabled')).equals(
      'true'
    )
    expect(byTestId('flip-button')!.querySelector('svg')).not.equals(null)
  })
})
