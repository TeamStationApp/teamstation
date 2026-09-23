import React, { useState } from 'react'
import { Text } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
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
  const theme = useTheme()
  const [draft, setDraft] = useState(input)
  const bases = [
    { id: 1, name: 'First' },
    { id: 2, name: 'Second' },
    { id: 3, name: 'Third' },
    { id: 4, name: 'Home' }
  ]
  const placed = input.action === 'Place a Runner (Tiebreaker)'
  const occupied = baseIds(state.session)
  const valid = moreReducer(state, { type: 'MORE', input: draft }) !== state
  return (
    <ScoringSheet title={input.action} onClose={onCancel}>
      {placed ? (
        <>
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
        </>
      ) : (
        <>
          <Text
            style={{
              color: theme.primaryTextColor,
              fontFamily: theme.regularTextFont
            }}
          >
            Confirm each runner’s destination. Runners crossing home still
            require Safe or Out.
          </Text>
          {occupied
            .filter((id): id is number => id != null)
            .map(id => (
              <ScoringChoice
                key={id}
                label={`Destination for ${state.session.gameData.players[id].fullName}`}
                value={draft.destinations?.[id] ?? null}
                options={bases.filter(option => option.id > input.base!)}
                onChange={base => {
                  if (base != null)
                    setDraft({
                      ...draft,
                      destinations: { ...draft.destinations, [id]: base }
                    })
                }}
              />
            ))}
        </>
      )}
      <ScoringButton
        label={placed ? 'Place Runner' : 'Confirm Placements'}
        disabled={!valid}
        onPress={() => {
          onSave(draft)
        }}
      />
    </ScoringSheet>
  )
}
