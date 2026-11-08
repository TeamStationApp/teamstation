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
        // A stand-in at an empty position is named by the position.
        const player =
          typeof id === 'number' ? state.session.gameData.players[id] : null
        const label =
          player == null
            ? String(id)
            : [player.jersey, player.fullName].filter(Boolean).join(' ')
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
