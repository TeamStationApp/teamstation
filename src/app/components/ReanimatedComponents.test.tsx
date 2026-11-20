/* eslint-disable @typescript-eslint/unbound-method -- Retain accessibility functions for restoration. */
import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AccessibilityInfo, Platform } from 'react-native'

import { RosterSelector } from '../scoring/RosterSelector'
import { SwitchHitterHint } from '../scoring/SwitchHitterHint'
import { ThemeProvider } from '../theme/ThemeContext'
import { GameHeroCard } from './GameHeroCard'
import {
  AnimatedLivePill,
  LivePill,
  LivePillHeld,
  livePillPulses
} from './LivePill'
import { SceneShownProvider } from './sceneShown'

const query = AccessibilityInfo.isReduceMotionEnabled
const subscribe = AccessibilityInfo.addEventListener
let root: Root | undefined
let host: HTMLDivElement
const listeners = new Set<(value: boolean) => void>()
const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}
async function render(
  view: React.ReactElement,
  reduced = false
): Promise<void> {
  AccessibilityInfo.isReduceMotionEnabled = async () => reduced
  AccessibilityInfo.addEventListener = (_name, fn) => {
    const listener = fn as (value: boolean) => void
    listeners.add(listener)
    return {
      remove: () => {
        listeners.delete(listener)
      }
    }
  }
  if (root == null) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(<ThemeProvider>{view}</ThemeProvider>)
  })
}
afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  AccessibilityInfo.isReduceMotionEnabled = query
  AccessibilityInfo.addEventListener = subscribe
  expect(listeners.size).equals(0)
})
describe('Reanimated UI components', () => {
  it('keeps Live and switch-hitter pulses readable and honors live reduced-motion changes and dismissal', async () => {
    let dismissed = 0
    await render(
      <>
        <AnimatedLivePill />
        <AnimatedLivePill inline />
        <SwitchHitterHint
          onDismiss={() => {
            dismissed++
          }}
        />
      </>
    )
    const live = host.querySelector<HTMLElement>('[aria-label="Live now"]')!
    const hint = host.querySelector<HTMLElement>(
      '[aria-label="Drag to the other batter box"]'
    )!
    await act(async () => {
      await delay(60)
      listeners.forEach(fn => {
        fn(true)
      })
    })
    expect(live.style.opacity).equals('1')
    expect(hint.style.opacity).equals('1')
    await act(async () => {
      listeners.forEach(fn => {
        fn(false)
      })
      await delay(30)
    })
    await act(async () => {
      host.querySelector<HTMLElement>('[aria-label="OK"]')!.click()
    })
    expect(dismissed).equals(1)
  })
  it('holds the Live pill still in a browser, where a pulse over the picture costs it frames', async function () {
    await render(<LivePill />)
    await act(async () => {
      await delay(60)
    })
    const live = host.querySelector<HTMLElement>('[aria-label="Live now"]')!
    expect(live.textContent).equals('live')
    expect(live.style.opacity).equals('')
    expect(['', 'none']).includes(getComputedStyle(live).animationName)
    expect(listeners.size, 'no motion preference to follow').equals(0)
  })
  it('pulses a pill only where it can be seen (issue 317)', async function () {
    const opacityOf = (): string =>
      host.querySelector<HTMLElement>('[aria-label="Live now"]')!.style.opacity
    const moves = async (): Promise<boolean> => {
      const seen = new Set<string>()
      for (let i = 0; i < 6; i++) {
        await act(async () => {
          await delay(60)
        })
        seen.add(opacityOf())
      }
      return [...seen].some(value => value !== '' && value !== '1')
    }
    const draw = async (shown: boolean, held: boolean): Promise<void> => {
      await render(
        <SceneShownProvider value={shown}>
          <LivePillHeld value={held}>
            <AnimatedLivePill />
          </LivePillHeld>
        </SceneShownProvider>
      )
    }

    await draw(true, false)
    expect(await moves(), 'shown and not held').equals(true)

    await draw(true, true)
    expect(await moves(), 'held under the angles').equals(false)
    expect(opacityOf()).equals('1')

    await draw(false, false)
    expect(await moves(), 'covered by another screen').equals(false)
    expect(opacityOf()).equals('1')

    await draw(true, false)
    expect(await moves(), 'shown again').equals(true)
  })

  it('holds the hero card’s live pill under a page that holds its pills (issue 317)', async function () {
    // The app's pill: a browser draws the still one whatever holds it.
    const platformWas = Platform.OS
    Platform.OS = 'ios'
    try {
      await render(
        <LivePillHeld value>
          <GameHeroCard
            awayTeamId="t1"
            homeTeamId="t2"
            awayName="Away"
            homeName="Home"
            awayScore={1}
            homeScore={2}
            status="TOP 3RD"
            // The pill sits in the card's meta row, which a venue brings.
            venue="Field 1"
            live
          />
        </LivePillHeld>
      )
      await act(async () => {
        await delay(300)
      })
      const live = host.querySelector<HTMLElement>('[aria-label="Live now"]')!
      expect(live.style.opacity).equals('1')
    } finally {
      Platform.OS = platformWas
    }
  })

  it('decides the pulse from motion, a hold and the screen on show (issue 317)', function () {
    for (const reduceMotion of [false, true])
      for (const held of [false, true])
        for (const shown of [false, true])
          expect(
            livePillPulses({ reduceMotion, held, shown }),
            JSON.stringify({ reduceMotion, held, shown })
          ).equals(!reduceMotion && !held && shown)
  })
  it('settles roster thumbs after programmatic selection and width changes with reduced motion', async () => {
    const draw = async (value: number): Promise<void> => {
      await render(
        <RosterSelector
          labels={['L', 'S', 'R']}
          value={value}
          onChange={() => undefined}
        />,
        true
      )
    }
    await draw(0)
    const thumb = host.querySelector<HTMLElement>(
      '[data-testid="Roster selector thumb"]'
    )!
    const track = thumb.parentElement as HTMLElement & {
      __reactLayoutHandler: (event: {
        nativeEvent: {
          layout: { width: number; height: number; x: number; y: number }
        }
      }) => void
    }
    const layout = async (width: number): Promise<void> => {
      await act(async () => {
        track.__reactLayoutHandler({
          nativeEvent: { layout: { width, height: 40, x: 0, y: 0 } }
        })
      })
      await act(async () => {
        await delay(80)
      })
    }
    await layout(300)
    await draw(2)
    await act(async () => {
      await delay(80)
    })
    expect(thumb.style.left).equals('200px')
    await layout(240)
    expect(thumb.style.left).equals('160px')
    await draw(1)
    await act(async () => {
      await delay(80)
    })
    expect(thumb.style.left).equals('80px')
    await act(async () => {
      listeners.forEach(fn => {
        fn(false)
      })
    })
    await draw(0)
    await act(async () => {
      await delay(220)
    })
    expect(thumb.style.left).equals('0px')
  })
})
