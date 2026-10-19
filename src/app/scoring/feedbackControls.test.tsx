import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Mesh } from 'three'

import { scoringSession } from '../../test/scoringSession'
import { BASES } from '../field/fieldModel'
import { MoveGuide } from '../field/MoveGuide'
import { gameFixture } from './isUnscoredGame.test'
import { MoreMenu } from './MoreMenu'
import { MoreMenu as NativeMore } from './MoreMenu.native'
import { OutcomePicker } from './OutcomePicker'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { bottomActionsAllowed } from './scoringSelectors'
import type { ScoringState } from './scoringTypes'

describe('feedback control locking and reversible guides', () => {
  it('rejects every bottom action during an unfinished gesture, motion or decision', () => {
    const ready = initialScoringState(scoringSession(gameFixture))
    expect(bottomActionsAllowed(ready)).equals(true)
    for (const state of [
      { ...ready, activeGesture: true },
      { ...ready, motions: [{ complete: false }] },
      ...[
        'fielderLocation',
        'trajectory',
        'defender',
        'homeDecision',
        'runnerDecision',
        'runnerReason',
        'correctionWindow',
        'awaitingBatter'
      ].map(phase => ({ ...ready, phase }))
    ] as ScoringState[]) {
      expect(bottomActionsAllowed(state)).equals(false)
      for (const event of [
        { type: 'PITCH', kind: 'ball' },
        { type: 'OUTCOME', outcome: 'Single' },
        { type: 'MORE', input: { action: 'Hit by Pitch' } }
      ] as const)
        expect(scoringReducer(state, event)).equals(state)
    }
  })
  for (const menu of ['outcomes', 'more', 'native'] as const)
    it(`closes ${menu} when disabled and ignores an interrupted release`, async () => {
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      const chosen: unknown[] = []
      const active: boolean[] = []
      const onActive = (value: boolean): void => {
        active.push(value)
      }
      const onChoose = (value: unknown): void => {
        chosen.push(value)
      }
      const state = initialScoringState(scoringSession(gameFixture))
      const render = async (disabled: boolean): Promise<void> => {
        await act(async () => {
          root.render(
            menu === 'outcomes' ? (
              <OutcomePicker
                disabled={disabled}
                onActive={onActive}
                onChoose={onChoose}
              />
            ) : menu === 'more' ? (
              <MoreMenu
                state={state}
                disabled={disabled}
                onActive={onActive}
                onChoose={onChoose}
              />
            ) : (
              <NativeMore
                state={state}
                disabled={disabled}
                onActive={onActive}
                onChoose={onChoose}
              />
            )
          )
        })
      }
      try {
        await render(false)
        const trigger = host.querySelector<HTMLElement>(
          `[aria-label="${menu === 'outcomes' ? 'Swing in Play' : 'More'}"]`
        )!
        await act(async () => {
          trigger.click()
        })
        expect(active.at(-1)).equals(true)
        await render(true)
        expect(active.at(-1)).equals(false)
        await act(async () => {
          for (const type of [
            'pointerdown',
            'pointermove',
            'pointerup',
            'click',
            'keydown'
          ])
            trigger.dispatchEvent(
              new window.MouseEvent(type, {
                bubbles: true,
                clientX: 100,
                clientY: 10
              })
            )
        })
        expect(chosen).has.length(0)
        expect(document.querySelector('[role="menu"]')).equals(null)
      } finally {
        await act(async () => {
          root.unmount()
        })
        host.remove()
      }
    })
  it('follows a live drag each frame without a re-render', async () => {
    const origin = BASES[1]
    const next = BASES[2]
    const draft = {
      id: 'runner',
      pointer: 1,
      origin,
      goal: origin,
      offset: { x: 0, z: 0 },
      next,
      commit: false,
      touch: true
    }
    const live = { current: { ...draft } }
    const renderer = await create(<MoveGuide draft={draft} live={live} />)
    try {
      const line = renderer.scene.findByProps({
        name: 'runner-transition-line'
      }).instance as Mesh
      const marker = renderer.scene.findByProps({
        name: 'destination-marker'
      }).instance
      expect(line.visible).equals(false)
      live.current.goal = {
        x: (origin.x + next.x) / 2,
        z: (origin.z + next.z) / 2
      }
      await renderer.advanceFrames(1, 1 / 60)
      expect(marker.position.x).equals(live.current.goal.x)
      expect(marker.position.z).equals(live.current.goal.z)
      expect(line.visible).equals(true)
      expect(line.position.x).closeTo(
        (origin.x + live.current.goal.x) / 2,
        1e-8
      )
      expect(line.scale.y).closeTo(
        Math.hypot(next.x - origin.x, next.z - origin.z) / 2,
        1e-6
      )
    } finally {
      await renderer.unmount()
    }
  })

  for (const base of [0, 1, 2, 3])
    it(`keeps base ${base} line and rings at the same reversible endpoint`, async () => {
      const origin = BASES[base]
      const next = BASES[(base + 1) % 4]
      const draft = {
        id: 'runner',
        pointer: 1,
        origin,
        goal: origin,
        offset: { x: 0, z: 0 },
        next,
        commit: false,
        touch: true
      }
      const renderer = await create(<MoveGuide draft={draft} />)
      try {
        for (const progress of [0, 0.25, 0.5, 0.51, 0.75, 0.25, 0]) {
          const t = progress > 0.5 ? 1 : progress
          draft.goal = {
            x: origin.x + (next.x - origin.x) * t,
            z: origin.z + (next.z - origin.z) * t
          }
          await renderer.update(<MoveGuide draft={{ ...draft }} />)
          const line = renderer.scene.findByProps({
            name: 'runner-transition-line'
          }).instance as Mesh
          const marker = renderer.scene.findByProps({
            name: 'destination-marker'
          }).instance
          expect(marker.position.x).equals(draft.goal.x)
          expect(marker.position.z).equals(draft.goal.z)
          expect(line.visible).equals(progress > 0)
          expect(line.position.x).closeTo((origin.x + draft.goal.x) / 2, 1e-8)
          expect(line.position.z).closeTo((origin.z + draft.goal.z) / 2, 1e-8)
        }
      } finally {
        await renderer.unmount()
      }
    })
})
