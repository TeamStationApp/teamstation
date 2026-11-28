/* eslint-disable @typescript-eslint/unbound-method -- Retain accessibility functions for restoration. */
import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AccessibilityInfo } from 'react-native'

import { ThemeProvider } from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { HeroReplayButton } from './HeroReplayButton'
import { AnimatedLivePill, LivePillHeld } from './LivePill'
import { PillFace, PillTabs } from './PillTabs'

const query = AccessibilityInfo.isReduceMotionEnabled
const subscribe = AccessibilityInfo.addEventListener
let root: Root | undefined
let host: HTMLElement | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function render(
  element: React.ReactElement,
  reduced = false
): Promise<HTMLElement> {
  AccessibilityInfo.isReduceMotionEnabled = async () => reduced
  AccessibilityInfo.addEventListener = () => ({ remove: () => undefined })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(<ThemeProvider>{element}</ThemeProvider>)
  })
  return host
}

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
  AccessibilityInfo.isReduceMotionEnabled = query
  AccessibilityInfo.addEventListener = subscribe
})

function hexToRgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))
  return `rgb(${r}, ${g}, ${b})`
}

function button(container: HTMLElement): HTMLElement {
  const found = container.querySelector<HTMLElement>(
    '[data-testid="game-hero-replay"]'
  )
  if (found == null) throw new Error('no hero replay button')
  return found
}

function faceOf(target: HTMLElement): HTMLElement {
  const face = target.querySelector<HTMLElement>(
    '[data-testid="settings-pill-tab"]'
  )
  if (face == null) throw new Error('no pill face')
  return face
}

function labelOf(face: HTMLElement): HTMLElement {
  const label = Array.from(face.querySelectorAll<HTMLElement>('*')).find(
    node => node.children.length === 0 && node.textContent !== ''
  )
  if (label == null) throw new Error('no label')
  return label
}

/** Whether the opacity round `target` moves over a few frames. */
async function pulses(target: () => HTMLElement): Promise<boolean> {
  const seen = new Set<string>()
  for (let i = 0; i < 6; i++) {
    await act(async () => {
      await delay(60)
    })
    seen.add(target().style.opacity)
  }
  return [...seen].some(value => value !== '' && value !== '1')
}

const noop = (): void => undefined

describe('the game hero’s Live / Replay button', function () {
  it('fills a live face red and a replay face green, each with a white label, and leaves an untoned face as it was', async function () {
    const container = await render(
      <>
        <PillFace label="Live" tone="live" />
        <PillFace label="Replay" tone="replay" />
        <PillFace label="Selected" />
        <PillFace label="Idle" selected={false} />
      </>
    )
    const faces = Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="settings-pill-tab"]'
      )
    )
    const colours = faces.map(face => [
      getComputedStyle(face).backgroundColor,
      getComputedStyle(labelOf(face)).color
    ])
    expect(colours).deep.equals([
      [hexToRgb(tsBallpark.liveColor), 'rgb(255, 255, 255)'],
      [hexToRgb(tsBallpark.replayActionColor), 'rgb(255, 255, 255)'],
      [
        hexToRgb(tsBallpark.pillActiveBackground),
        hexToRgb(tsBallpark.pillActiveTextColor)
      ],
      [hexToRgb(tsBallpark.pillBackground), hexToRgb(tsBallpark.pillTextColor)]
    ])
  })

  it('is the size of a compact section pill beside it', async function () {
    const container = await render(
      <>
        <PillTabs
          tabs={[{ id: 'info', label: 'Info' }]}
          selected="info"
          onSelect={noop}
          size="compact"
        />
        <HeroReplayButton kind="replay" label="Replay" onPress={noop} />
      </>
    )
    const section = faceOf(
      container.querySelector<HTMLElement>('[role="tablist"]')!
    )
    const hero = faceOf(button(container))
    for (const property of [
      'height',
      'minHeight',
      'paddingLeft',
      'paddingRight',
      'borderTopLeftRadius'
    ] as const)
      expect(getComputedStyle(hero)[property], property).equals(
        getComputedStyle(section)[property]
      )
    expect(getComputedStyle(labelOf(hero)).fontSize).equals(
      getComputedStyle(labelOf(section)).fontSize
    )
  })

  it('is a button named by its label that answers a press, and none while disabled', async function () {
    let presses = 0
    const container = await render(
      <HeroReplayButton
        kind="live"
        label="Live"
        onPress={() => {
          presses++
        }}
      />
    )
    const target = button(container)
    expect(target.getAttribute('role')).equals('button')
    expect(target.getAttribute('aria-label')).equals('Live')
    expect(target.textContent).equals('Live')
    await act(async () => {
      target.click()
    })
    expect(presses).equals(1)

    await act(async () => {
      root?.unmount()
    })
    host?.remove()
    const off = await render(
      <HeroReplayButton
        kind="replay"
        label="Replay"
        disabled
        onPress={() => {
          presses++
        }}
      />
    )
    const disabled = button(off)
    expect(getComputedStyle(disabled).opacity).equals('0.5')
    await act(async () => {
      disabled.click()
    })
    expect(presses).equals(1)
  })

  it('pulses Live only, and holds it still when asked, under a held page, or for reduced motion', async function () {
    const wrapper = (): HTMLElement => button(host!).parentElement!
    const redraw = async (
      element: React.ReactElement,
      reduced = false
    ): Promise<void> => {
      if (root != null) {
        await act(async () => {
          root?.unmount()
        })
        host?.remove()
      }
      await render(element, reduced)
    }

    await redraw(<HeroReplayButton kind="live" label="Live" onPress={noop} />)
    expect(await pulses(wrapper), 'live').equals(true)

    await redraw(
      <HeroReplayButton kind="replay" label="Replay" onPress={noop} />
    )
    expect(await pulses(wrapper), 'replay').equals(false)

    await redraw(
      <HeroReplayButton kind="live" label="Live" still onPress={noop} />
    )
    expect(await pulses(wrapper), 'still').equals(false)

    await redraw(
      <LivePillHeld value>
        <HeroReplayButton kind="live" label="Live" onPress={noop} />
      </LivePillHeld>
    )
    expect(await pulses(wrapper), 'held').equals(false)

    await redraw(
      <HeroReplayButton kind="live" label="Live" onPress={noop} />,
      true
    )
    expect(await pulses(wrapper), 'reduced motion').equals(false)
  })

  it('still pulses the live pill through the same hook', async function () {
    await render(<AnimatedLivePill />)
    expect(
      await pulses(() =>
        host!.querySelector<HTMLElement>('[aria-label="Live now"]')!
      )
    ).equals(true)
  })
})
