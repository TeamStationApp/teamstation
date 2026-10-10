import React from 'react'

import { ScoringPlayerCard } from './ScoringPlayerCard'
import { ScoringSheet } from './ScoringSheet'
import type { ScoringEvent, ScoringState } from './scoringTypes'

export function ErrorCreditSheet({
  state,
  dispatch
}: {
  state: ScoringState
  dispatch: (event: ScoringEvent) => void
}): React.ReactElement | null {
  if (state.phase !== 'errorCredit') return null
  const ids = [
    ...new Set(state.runnerAction?.defensiveRoute?.map(hop => hop.id))
  ]
  return (
    <ScoringSheet
      title="Who committed the error?"
      onClose={() => {
        dispatch({ type: 'ERROR_CANCEL' })
      }}
    >
      {ids.map(id => {
        const player = state.session.gameData.players[id]
        const label = [player.jersey, player.fullName].filter(Boolean).join(' ')
        return (
          <ScoringPlayerCard
            key={id}
            label={`Error by ${label}`}
            name={label}
            onPress={() => {
              dispatch({
                type: 'ERROR_CREDIT',
                id,
                generation: state.generation
              })
            }}
          />
        )
      })}
    </ScoringSheet>
  )
}
