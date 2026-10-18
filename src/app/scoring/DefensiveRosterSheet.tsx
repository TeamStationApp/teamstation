import React, { useRef, useState } from 'react'
import {
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View
} from 'react-native'

import { defensiveRosterLabel, defensiveRosterName } from './currentSetup'
import type { PlayerDraft } from './playerDraft'
import { PlayerEntrySheet } from './PlayerEntrySheet'
import { byJersey } from './rosterOrder'
import { scoringPlayerCardStyle } from './ScoringPlayerCard'
import { ScoringButton, ScoringSheet } from './ScoringSheet'
import { useScoringSheetTheme } from './scoringSheetTheme'
import {
  type Position,
  POSITIONS,
  type ScoringSessionState,
  type Side
} from './scoringTypes'

export const DEFENSIVE_POSITION_NAMES: Record<Position, string> = {
  P: 'pitcher',
  C: 'catcher',
  '1B': 'first base',
  '2B': 'second base',
  SS: 'shortstop',
  '3B': 'third base',
  LF: 'left field',
  CF: 'center field',
  RF: 'right field'
}

export function DefensiveRosterSheet({
  session,
  side,
  position,
  onClose,
  onChoose,
  onAddPlayer,
  onAddPlaceholders,
  onCancelCreate,
  onRefresh,
  busy = false,
  problem
}: {
  session: ScoringSessionState
  side: Side
  position: Position
  onClose: () => void
  onChoose: (id: number) => void
  onAddPlayer: (draft: PlayerDraft) => Promise<void>
  onAddPlaceholders: (count: number) => Promise<void>
  onCancelCreate?: () => void
  onRefresh: () => void
  busy?: boolean
  problem?: string
}): React.ReactElement {
  const theme = useScoringSheetTheme()
  const surface = theme.scoringSurface
  const badge = surface.badges.green
  const { height } = useWindowDimensions()
  const [adding, setAdding] = useState(false)
  const shown = useRef(false)
  const team = session.liveData.boxscore.teams[side]
  const names = session.gameData.players
  const fieldPosition = (id: number): Position | undefined =>
    POSITIONS.find(slot => team.defense[slot] === id)
  const ordered = byJersey(team.players, names)
  const groups = [
    { title: 'Bench', ids: ordered.filter(id => fieldPosition(id) == null) },
    { title: 'Fielders', ids: ordered.filter(id => fieldPosition(id) != null) }
  ]
  return (
    <ScoringSheet
      title={`Assign ${DEFENSIVE_POSITION_NAMES[position]}`}
      height={Math.round((height * 2) / 3)}
      appearance="scoring"
      compact={height < 650}
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
      <View style={{ flex: 1, gap: 12 }}>
        {problem != null && (
          <Text accessibilityRole="alert" style={{ color: surface.danger }}>
            {problem}
          </Text>
        )}
        {busy && (
          <Text style={{ color: surface.text }}>Refreshing game...</Text>
        )}
        <ScrollView
          accessibilityLabel="Defensive roster"
          style={{ flex: 1, minHeight: 0 }}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ gap: 18, paddingBottom: 8 }}
        >
          {groups.map(group => (
            <View
              key={group.title}
              testID={`Defensive ${group.title}`}
              style={{ gap: 8 }}
            >
              <Text
                accessibilityRole="header"
                style={{
                  color: surface.text,
                  fontFamily: theme.boldTextFont,
                  fontSize: 16,
                  textAlign: 'left'
                }}
              >
                {group.title}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {group.ids.map(id => {
                  const player = names[id]
                  const slot = fieldPosition(id)
                  const name = defensiveRosterName(player)
                  const jersey = player.jersey.trim()
                  return (
                    <Pressable
                      key={id}
                      testID={`Defensive player ${id}`}
                      accessibilityRole="button"
                      disabled={busy}
                      accessibilityLabel={`Assign ${position} ${defensiveRosterLabel(player)}`}
                      onPress={() => {
                        onChoose(id)
                      }}
                      style={({ pressed }) => ({
                        ...scoringPlayerCardStyle(theme, pressed),
                        width: '48%',
                        opacity: busy ? 0.4 : 1
                      })}
                    >
                      {slot != null && (
                        <View
                          testID={`Defensive position ${id}`}
                          style={{
                            width: 28,
                            minHeight: 28,
                            borderRadius: 6,
                            borderWidth: 1,
                            borderColor: badge.border,
                            backgroundColor: badge.background,
                            justifyContent: 'center',
                            alignItems: 'center'
                          }}
                        >
                          <Text
                            style={{
                              color: badge.text,
                              fontFamily: theme.boldTextFont,
                              fontSize: 12
                            }}
                          >
                            {slot}
                          </Text>
                        </View>
                      )}
                      <Text
                        style={{
                          flex: 1,
                          minWidth: 0,
                          color: surface.text,
                          fontFamily: theme.semiBoldTextFont,
                          fontSize: 13
                        }}
                      >
                        {name}
                        {jersey === '' ? '' : ` #${jersey}`}
                      </Text>
                    </Pressable>
                  )
                })}
              </View>
            </View>
          ))}
        </ScrollView>
        <ScoringButton
          label="Create Player"
          color={surface.active}
          shape="pill"
          disabled={busy}
          onPress={() => {
            setAdding(true)
          }}
        />
      </View>
      {adding && (
        <PlayerEntrySheet
          onClose={() => {
            setAdding(false)
          }}
          onCancel={() => {
            onCancelCreate?.()
            setAdding(false)
            onRefresh()
          }}
          onAdd={async draft => {
            await onAddPlayer(draft)
          }}
          onAddPlaceholders={onAddPlaceholders}
        />
      )}
    </ScoringSheet>
  )
}
