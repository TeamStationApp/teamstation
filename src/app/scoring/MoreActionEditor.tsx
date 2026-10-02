import React, { useState } from 'react'

import { type MoreInput, moreReducer } from './moreActions'
import { ScoringChoice } from './ScoringChoice'
import { baseIds, battingSide } from './scoringSelectors'
import { ScoringButton, ScoringSheet } from './ScoringSheet'
import type { ScoringState } from './scoringTypes'
export function MoreActionEditor({
  state,
  input,
  onSave,
  onCancel
}: {
  state: ScoringState
  input: MoreInput
  onSave: (input: MoreInput) => void
  onCancel: () => void
}): React.ReactElement {
  const [draft, setDraft] = useState(input)
  const bases = [
    { id: 1, name: 'First' },
    { id: 2, name: 'Second' },
    { id: 3, name: 'Third' },
    { id: 4, name: 'Home' }
  ]
  const occupied = baseIds(state.session)
  const valid = moreReducer(state, { type: 'MORE', input: draft }) !== state
  return (
    <ScoringSheet title={input.action} onClose={onCancel}>
      <ScoringChoice
        label="Placed runner"
        value={draft.playerId ?? null}
        options={state.session.liveData.boxscore.teams[
          battingSide(state.session)
        ].players
          .filter(
            id =>
              id !== state.session.liveData.linescore.offense.batter?.id &&
              !occupied.includes(id)
          )
          .map(id => ({
            id,
            name: state.session.gameData.players[id].fullName
          }))}
        onChange={id => {
          setDraft({ ...draft, playerId: id ?? undefined })
        }}
      />
      <ScoringChoice
        label="Destination base"
        value={draft.base ?? null}
        options={bases.filter(
          option => option.id < 4 && occupied[option.id - 1] == null
        )}
        onChange={base => {
          setDraft({ ...draft, base: base ?? undefined })
        }}
      />
      <ScoringButton
        label="Place Runner"
        disabled={!valid}
        onPress={() => {
          onSave(draft)
        }}
      />
    </ScoringSheet>
  )
}
