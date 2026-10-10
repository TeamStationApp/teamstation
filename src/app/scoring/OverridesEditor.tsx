import React, { useState } from 'react'
import { Text, View } from 'react-native'

import { overrideError, overrideOf } from '../../common/scoring/rules'
import { useTheme } from '../theme/ThemeContext'
import { ScoringChoice } from './ScoringChoice'
import { ScoringButton, ScoringError } from './ScoringSheet'
import { ScoringTextInput } from './ScoringTextInput'
import type { OverrideDraft, ScoringState } from './scoringTypes'
export function OverridesEditor({
  state,
  onApply
}: {
  state: ScoringState
  onApply: (draft: OverrideDraft) => void
}): React.ReactElement {
  const theme = useTheme()
  const [draft, setDraft] = useState(() => overrideOf(state.session))
  const [numbers, setNumbers] = useState(() => ({
    inning: String(draft.inning),
    awayScore: String(draft.awayScore),
    homeScore: String(draft.homeScore),
    balls: String(draft.balls),
    strikes: String(draft.strikes),
    outs: String(draft.outs)
  }))
  const session = state.session
  const team = session.liveData.boxscore.teams[draft.top ? 'away' : 'home']
  const fielders = session.liveData.boxscore.teams[draft.top ? 'home' : 'away']
  const options = (ids: number[]): Array<{ id: number; name: string }> =>
    ids.map(id => ({ id, name: session.gameData.players[id].fullName }))
  const error = overrideError(state.session, draft)
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {[true, false].map(top => (
          <ScoringButton
            key={String(top)}
            label={top ? 'Top' : 'Bottom'}
            color={
              top === draft.top ? theme.scoringInstructionBackground : undefined
            }
            onPress={() => {
              if (top !== draft.top)
                setDraft({
                  ...draft,
                  top,
                  batter: null,
                  pitcher: null,
                  bases: [null, null, null]
                })
            }}
          />
        ))}
      </View>
      {(Object.keys(numbers) as Array<keyof typeof numbers>).map(key => (
        <View key={key} style={{ gap: 4 }}>
          <Text
            style={{
              color: theme.primaryTextColor,
              fontFamily: theme.regularTextFont
            }}
          >
            {
              {
                inning: 'Inning',
                awayScore: `${session.gameData.teams.away.name} score`,
                homeScore: `${session.gameData.teams.home.name} score`,
                balls: 'Balls',
                strikes: 'Strikes',
                outs: 'Outs'
              }[key]
            }
          </Text>
          <ScoringTextInput
            accessibilityLabel={key}
            keyboardType="number-pad"
            value={numbers[key]}
            onChangeText={value => {
              setNumbers({ ...numbers, [key]: value })
              setDraft({
                ...draft,
                [key]: value.trim() === '' ? NaN : Number(value)
              })
            }}
          />
        </View>
      ))}
      <ScoringChoice
        label="Batter"
        value={draft.batter}
        options={options(team.battingOrder)}
        onChange={batter => {
          setDraft({ ...draft, batter })
        }}
      />
      <ScoringChoice
        label="Pitcher"
        value={draft.pitcher}
        options={options(fielders.players)}
        onChange={pitcher => {
          setDraft({ ...draft, pitcher })
        }}
      />
      {['First base', 'Second base', 'Third base'].map((label, index) => (
        <ScoringChoice
          key={label}
          label={label}
          value={draft.bases[index]}
          options={[{ id: null, name: 'Empty' }, ...options(team.players)]}
          onChange={id => {
            const bases = [...draft.bases]
            bases[index] = id
            setDraft({ ...draft, bases })
          }}
        />
      ))}
      <ScoringError message={error} />
      <ScoringButton
        label="Apply Override"
        disabled={error != null}
        onPress={() => {
          onApply(draft)
        }}
      />
    </View>
  )
}
