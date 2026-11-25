import React, { createContext, useContext, useMemo, useState } from 'react'
import { Text, View } from 'react-native'

import { applyAction, endGameFiling } from '../../common/scoring/session'
import { copyGame, type GameState } from '../../common/scoring/state'
import { useTheme } from '../theme/ThemeContext'
import { ScoringButton, ScoringSheet } from './ScoringSheet'

export function EndGameConfirmation({
  session,
  disabled,
  onConfirm
}: {
  session: GameState
  disabled: boolean
  onConfirm: () => void
}): React.ReactElement {
  const theme = useTheme()
  const { away, home } = session.gameData.teams
  // The score shown is the one End Game stores, whatever it files. A game
  // the engine would refuse to end keeps the score on the board.
  const runs = useMemo(() => {
    const ended = applyAction(
      copyGame(session),
      { type: 'gameFlow', kind: 'endGame' },
      { inPlace: true }
    )
    return (ended.problems.length === 0 ? ended.state : session).liveData
      .linescore.teams
  }, [session])
  const filing = endGameFiling(session)
  let detail: string | undefined
  if (filing.kind === 'batted')
    detail = 'The pitch in play is left out of the book.'
  if (filing.kind === 'begun')
    detail = 'The open at-bat is saved with its pitches.'
  if (filing.kind === 'partial')
    detail = `The play is saved as ${filing.result}. What is still undecided is left undecided.`
  const style = {
    color: theme.primaryTextColor,
    fontFamily: theme.regularTextFont
  }
  return (
    <View style={{ gap: 12 }}>
      <Text style={style}>
        End the game at {away.name} {runs.away.runs}, {home.name}{' '}
        {runs.home.runs}? Undo takes it back.
      </Text>
      {detail != null && <Text style={style}>{detail}</Text>}
      <ScoringButton
        label="Confirm End Game"
        disabled={disabled}
        onPress={onConfirm}
      />
    </View>
  )
}

/** Decision sheets reuse their presented modal, so Cancel returns to the same choice on iOS. */
export const EndGameContext = createContext<React.ReactElement | null>(null)

export function useDecisionEndGame(): {
  button: React.ReactElement | null
  confirmation: React.ReactElement | null
  handleCancel: () => void
} {
  const content = useContext(EndGameContext)
  const [asking, setAsking] = useState(false)
  return {
    button:
      content == null ? null : (
        <ScoringButton
          row
          label="End Game"
          onPress={() => {
            setAsking(true)
          }}
        />
      ),
    confirmation: asking ? content : null,
    handleCancel: () => {
      setAsking(false)
    }
  }
}

export function ScoringDecisionSheet(
  props: React.ComponentProps<typeof ScoringSheet>
): React.ReactElement {
  const end = useDecisionEndGame()
  if (end.confirmation != null)
    return (
      <ScoringSheet title="End Game" onClose={end.handleCancel}>
        {end.confirmation}
      </ScoringSheet>
    )
  return (
    <ScoringSheet {...props}>
      {props.children}
      {end.button}
    </ScoringSheet>
  )
}
