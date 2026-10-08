import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { AccessibilityInfo, Text } from 'react-native'

import { ThemeProvider } from '../theme/ThemeContext'
import { RosterDragGroup, useRosterGesture } from './RosterDragContext'
import { RosterFeedback } from './rosterFeedback'
import type { RosterGesture, RosterPreview } from './rosterGesture'

const preview = (
  x = 10,
  target?: string,
  source = 'player'
): RosterPreview => ({
  x,
  y: 10,
  source,
  label: 'Demo Player',
  target,
  cardRect: { x: 0, y: 0, width: 100, height: 48 }
})

describe('roster gesture feedback', function () {
  it('cues ready once and only new valid defensive entries', function () {
    const events: string[] = []
    const feedback = new RosterFeedback({
      ready: () => events.push('ready'),
      hover: () => events.push('hover'),
      reset: () => events.push('reset')
    })
    feedback.update(null, false)
    expect(events.filter(x => x !== 'reset')).deep.equals([])
    feedback.update(preview(), true)
    feedback.update(preview(), true)
    expect(events.filter(x => x === 'ready')).length(1)
    feedback.update(preview(30, 'defense-P'), true)
    const resets = events.filter(x => x === 'reset').length
    feedback.update(preview(31, 'defense-P'), true)
    feedback.update(preview(32, 'defense-P'), true)
    expect(events.filter(x => x === 'reset')).length(resets)
    expect(events.filter(x => x === 'hover')).length(1)
    feedback.update(preview(33, 'defense-C'), true)
    feedback.update(preview(34, 'roster'), true)
    feedback.update(preview(35, 'defense-C'), true)
    feedback.update(preview(36, 'defense-bogus'), true)
    feedback.update(preview(37, 'lineup-0'), true)
    expect(events.filter(x => x === 'hover')).length(3)
    feedback.update(null, false)
    feedback.update(preview(10, 'defense-P'), true)
    expect(events.filter(x => x === 'ready')).length(2)
    expect(events.filter(x => x === 'hover')).length(4)
  })
  it('requires a registered measured source and resets for another source', function () {
    let ready = 0
    const feedback = new RosterFeedback({
      ready: () => {
        ready++
      },
      hover: () => undefined,
      reset: () => undefined
    })
    feedback.update(preview(), false)
    feedback.update({ ...preview(), source: undefined }, true)
    feedback.update({ ...preview(), cardRect: undefined }, true)
    feedback.update(
      { ...preview(), cardRect: { x: 0, y: 0, width: 0, height: 48 } },
      true
    )
    expect(ready).equals(0)
    const immutable = Object.freeze(preview())
    feedback.update(immutable, true)
    feedback.update(preview(10, undefined, 'another'), true)
    expect(ready).equals(2)
    expect(immutable).deep.equals(preview())
  })
  it('never makes optional feedback failures into gesture failures', function () {
    const fail = (): never => {
      throw new Error('Unsupported feedback')
    }
    const feedback = new RosterFeedback({
      ready: fail,
      hover: fail,
      reset: fail
    })
    expect(() => {
      feedback.update(preview(), true)
      feedback.update(preview(30, 'defense-P'), true)
      feedback.reset()
    }).not.throws()
  })
})

describe('rendered roster feedback', function () {
  for (const reduced of [true, false]) {
    it(`keeps light readiness with reduced motion ${String(reduced)} and resets on movement/end`, async function () {
      // Preserve the original method identity when restoring global test state.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const query = AccessibilityInfo.isReduceMotionEnabled
      const vibration = Object.getOwnPropertyDescriptor(navigator, 'vibrate')
      const subscription = Object.getOwnPropertyDescriptor(
        AccessibilityInfo,
        'addEventListener'
      )
      let motionChanged: ((value: boolean) => void) | undefined
      Object.defineProperty(AccessibilityInfo, 'addEventListener', {
        configurable: true,
        value: (event: string, handler: (value: boolean) => void) => {
          if (event === 'reduceMotionChanged') motionChanged = handler
          return { remove: () => undefined }
        }
      })
      AccessibilityInfo.isReduceMotionEnabled = async () => reduced
      let requests = 0
      Object.defineProperty(navigator, 'vibrate', {
        configurable: true,
        value: () => {
          requests++
          return false
        }
      })
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      let engine: RosterGesture | undefined
      function Probe(): React.ReactElement {
        const value = useRosterGesture()
        useEffect(() => {
          engine = value
          value.sources.set('row', {
            measure: async () => ({ x: 0, y: 0, width: 100, height: 48 }),
            clip: async () => ({ x: 0, y: 0, width: 200, height: 100 }),
            content: <Text>Demo Player</Text>
          })
          return () => {
            value.sources.delete('row')
          }
        }, [value])
        return <Text>Source</Text>
      }
      try {
        await act(async () => {
          root.render(
            <ThemeProvider>
              <RosterDragGroup>
                <Probe />
              </RosterDragGroup>
            </ThemeProvider>
          )
        })
        await act(async () => {
          engine!.begin(1, 'Demo Player', { x: 10, y: 10 }, 'row')
          await new Promise(resolve => setTimeout(resolve, 10))
        })
        if (!reduced) {
          await act(async () => {
            motionChanged?.(true)
          })
          await new Promise(resolve => setTimeout(resolve, 30))
          const ghost = host.querySelector<HTMLElement>(
            '[data-testid="Roster dragged card"]'
          )!
          expect(window.getComputedStyle(ghost).transform).equals('scale(1)')
        }
        expect(requests).equals(1)
        expect(
          host.querySelector('[data-testid="Roster dragged card"]')
        ).not.equals(null)
        await act(async () => {
          await engine!.move({ x: 30, y: 10 })
          engine!.cancel()
        })
        expect(
          host.querySelector('[data-testid="Roster dragged card"]')
        ).equals(null)
        expect(requests).equals(1)
      } finally {
        await act(async () => {
          root.unmount()
        })
        host.remove()
        AccessibilityInfo.isReduceMotionEnabled = query
        if (subscription != null)
          Object.defineProperty(
            AccessibilityInfo,
            'addEventListener',
            subscription
          )
        if (vibration == null) delete (navigator as Partial<Navigator>).vibrate
        else Object.defineProperty(navigator, 'vibrate', vibration)
      }
    })
  }
})
