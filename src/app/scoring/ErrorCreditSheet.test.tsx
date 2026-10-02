import { expect } from 'chai'
import { it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { completeMotions } from '../../test/scoringHelpers'
import { errorState } from './errorAttribution.test'
import { ErrorCreditSheet } from './ErrorCreditSheet'
import { scoringReducer } from './scoringMachine'
import type { ScoringEvent } from './scoringTypes'
it('lists involved error defenders once with jersey then full name and preserves cancel intent', async function () {
  let state = completeMotions(errorState())
  state = scoringReducer(state, {
    type: 'DEFENDER',
    id: 11,
    point: { x: 10, z: -20 },
    generation: 0
  })
  state = scoringReducer(state, {
    type: 'DEFENDER',
    id: 10,
    point: { x: 0, z: -30 },
    generation: 0
  })
  state = scoringReducer(state, { type: 'DEFENDER', generation: 0 })
  state.session.gameData.players[10].fullName = 'Jane Doe'
  state.session.gameData.players[10].jersey = '00'
  state.session.gameData.players[11].jersey = ''
  const events: ScoringEvent[] = []
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(
        <ErrorCreditSheet
          state={state}
          dispatch={e => {
            events.push(e)
          }}
        />
      )
    })
    expect(
      document.querySelectorAll('[aria-label="Error by 00 Jane Doe"]')
    ).has.length(1)
    expect(
      document.querySelectorAll('[aria-label="Error by Player 2"]')
    ).has.length(1)
    await act(async () => {
      document
        .querySelector<HTMLElement>('[aria-label="Error by 00 Jane Doe"]')!
        .click()
    })
    expect(events.at(-1)).deep.equals({
      type: 'ERROR_CREDIT',
      id: 10,
      generation: 0
    })
    await act(async () => {
      document.querySelector<HTMLElement>('[aria-label="Cancel"]')!.click()
    })
    expect(events.at(-1)).deep.equals({ type: 'ERROR_CANCEL' })
    await act(async () => {
      root.render(
        <ErrorCreditSheet
          state={{ ...state, phase: 'ready' }}
          dispatch={() => undefined}
        />
      )
    })
    expect(
      document.querySelector('[aria-label="Error by 00 Jane Doe"]')
    ).equals(null)
  } finally {
    await act(async () => {
      root.unmount()
    })
  }
})
