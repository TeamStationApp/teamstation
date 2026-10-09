import React, { useRef, useState } from 'react'
import {
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View
} from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import { defensiveRosterLabel } from './currentSetup'
import { PlaceholderPlayersSheet } from './PlaceholderPlayersSheet'
import { byJersey } from './rosterOrder'
import { ScoringSheet } from './ScoringSheet'
import type { Position, ScoringSessionState, Side } from './scoringTypes'

export function DefensiveRosterSheet({
  session,
  side,
  position,
  openedEmpty,
  onClose,
  onChoose,
  onAddPlaceholders,
  busy = false,
  problem
}: {
  session: ScoringSessionState
  side: Side
  position: Position
  openedEmpty: boolean
  onClose: () => void
  onChoose: (id: number) => void
  onAddPlaceholders: (count: number) => void
  busy?: boolean
  problem?: string
}): React.ReactElement {
  const theme = useTheme()
  const { height } = useWindowDimensions()
  const compact = height < 650
  const [adding, setAdding] = useState(false)
  const shown = useRef(false)
  const team = session.liveData.boxscore.teams[side]
  const names = session.gameData.players
  return (
    <>
      <ScoringSheet
        title={busy ? 'Refreshing game...' : `Assign ${position}`}
        compact={compact}
        placement={compact ? 'top' : 'bottom'}
        textCancel
        scroll={false}
        onShow={() => {
          shown.current = true
        }}
        onBackdropPress={() => {
          if (shown.current) onClose()
        }}
        onClose={onClose}
      >
        {problem != null && (
          <Text accessibilityRole="alert" style={{ color: theme.dangerColor }}>
            {problem}
          </Text>
        )}
        <ScrollView
          accessibilityLabel="Defensive roster"
          style={{ maxHeight: compact ? 44 : 104 }}
          keyboardShouldPersistTaps="handled"
        >
          <View
            testID="Defensive roster grid"
            style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}
          >
            {byJersey(team.players, names).map(id => (
              <Pressable
                key={id}
                accessibilityRole="button"
                disabled={busy}
                accessibilityLabel={`Assign ${position} ${defensiveRosterLabel(names[id])}`}
                onPress={() => {
                  onChoose(id)
                }}
                style={{
                  width: '48%',
                  minHeight: 44,
                  justifyContent: 'center',
                  alignItems: 'center',
                  borderRadius: 6,
                  backgroundColor: theme.scoringSelectorIdle
                }}
              >
                <Text
                  style={{
                    color: theme.primaryTextColor,
                    fontFamily: theme.semiBoldTextFont
                  }}
                >
                  {defensiveRosterLabel(names[id])}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
        {openedEmpty && team.players.length < 9 && (
          <Pressable
            accessibilityRole="button"
            disabled={busy}
            accessibilityLabel="Create Placeholder Players"
            onPress={() => {
              setAdding(true)
            }}
            style={{
              minHeight: compact ? 32 : 44,
              justifyContent: 'center',
              alignItems: 'center'
            }}
          >
            <Text
              style={{
                color: theme.primaryTextColor,
                fontFamily: theme.regularTextFont,
                fontSize: 13
              }}
            >
              Create Placeholder Players
            </Text>
          </Pressable>
        )}
      </ScoringSheet>
      {adding && (
        <PlaceholderPlayersSheet
          onClose={() => {
            setAdding(false)
          }}
          onAdd={onAddPlaceholders}
        />
      )}
    </>
  )
}
