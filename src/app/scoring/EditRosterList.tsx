import React, { useCallback, useLayoutEffect, useRef } from 'react'
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  Switch,
  Text,
  View
} from 'react-native'

import { lstrings } from '../locales/strings'
import { ScoringPlayerCard } from './ScoringPlayerCard'
import type { EditRosterRow } from './scoringRosterEdit'
import {
  editRosterLabel,
  JERSEY_BADGE_SIZE,
  rosterHand
} from './scoringRosterEdit'
import { ScoringButton, ScoringError } from './ScoringSheet'
import { useScoringSheetTheme } from './scoringSheetTheme'

export function EditRosterList({
  rows,
  loading,
  error,
  onRetry,
  onEdit,
  onEditLocal,
  unrostered = [],
  rosterBusy = false,
  onRosteredChange,
  visible = true,
  initialScrollOffset,
  onScrollOffset
}: {
  rows: readonly EditRosterRow[]
  loading?: boolean
  error?: string
  onRetry?: () => void
  onEdit?: (userId: number, name: string) => void
  onEditLocal?: (id: number) => void
  unrostered?: readonly number[]
  rosterBusy?: boolean
  onRosteredChange?: (userId: number, rostered: boolean) => void
  visible?: boolean
  initialScrollOffset?: number
  onScrollOffset?: (offset: number) => void
}): React.ReactElement {
  const theme = useScoringSheetTheme()
  const text = {
    color: theme.scoringSurface.text,
    fontFamily: theme.regularTextFont,
    fontSize: 14
  }
  const badge = theme.scoringSurface.badges.green
  const initialOffset = useRef({ x: 0, y: initialScrollOffset ?? 0 })
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const restorePending = useRef(true)
  const restoreScroll = useCallback(() => {
    if (!visible || loading === true || !restorePending.current) return
    if (rows.length === 0 && initialOffset.current.y !== 0) return
    scroll.current?.scrollTo({ ...initialOffset.current, animated: false })
    restorePending.current = false
  }, [visible, loading, rows.length])
  useLayoutEffect(() => {
    if (!visible || loading === true) restorePending.current = true
    else if (Platform.OS === 'web') restoreScroll()
  }, [visible, loading, restoreScroll])
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 8 }}>
      {loading === true && (
        <ActivityIndicator
          accessibilityLabel="Loading team roster"
          color={theme.scoringSurface.accent}
        />
      )}
      {loading !== true &&
        onEdit == null &&
        rows.some(row => row.userId != null) && (
          <Text style={text}>{lstrings.scoring_roster_edit_unavailable}</Text>
        )}
      {error != null && (
        <>
          <ScoringError message={error} />
          {onRetry != null && (
            <ScoringButton label="Retry loading roster" onPress={onRetry} />
          )}
        </>
      )}
      <ScrollView
        ref={scroll}
        contentOffset={initialOffset.current}
        onLayout={restoreScroll}
        onContentSizeChange={restoreScroll}
        scrollEventThrottle={100}
        onScroll={event => {
          if (!visible || loading === true || restorePending.current) return
          initialOffset.current = { x: 0, y: event.nativeEvent.contentOffset.y }
          onScrollOffset?.(event.nativeEvent.contentOffset.y)
        }}
        testID="Edit roster players"
        style={{ flex: 1 }}
        contentContainerStyle={{ gap: 8, padding: 8 }}
        keyboardShouldPersistTaps="handled"
      >
        {rows.length === 0 && loading !== true && (
          <Text style={text}>{lstrings.scoring_roster_empty}</Text>
        )}
        {rows.map(row => (
          <ScoringPlayerCard
            key={row.key}
            label={editRosterLabel(row)}
            trailing={
              row.userId == null || onRosteredChange == null ? undefined : (
                <Switch
                  accessibilityLabel="Rostered for this game"
                  testID={`Rostered ${row.userId}`}
                  value={!unrostered.includes(row.userId)}
                  disabled={rosterBusy}
                  onValueChange={value => {
                    onRosteredChange(row.userId!, value)
                  }}
                />
              )
            }
            disabled={row.userId == null ? onEditLocal == null : onEdit == null}
            onPress={() => {
              if (row.userId != null) onEdit?.(row.userId, row.navigationTitle)
              else onEditLocal?.(row.id)
            }}
          >
            <View
              testID={`Jersey badge ${row.key}`}
              style={{
                width: JERSEY_BADGE_SIZE,
                height: JERSEY_BADGE_SIZE,
                flexShrink: 0,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: badge.border,
                backgroundColor: badge.background,
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <Text
                style={{
                  ...text,
                  fontSize: 21,
                  color: badge.text,
                  fontFamily: theme.semiBoldTextFont
                }}
              >
                {row.jersey === '' ? '—' : `#${row.jersey}`}
              </Text>
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
              <Text style={{ ...text, fontFamily: theme.semiBoldTextFont }}>
                {row.name}
              </Text>
              <Text
                style={{ ...text, color: theme.scoringSurface.secondaryText }}
              >
                {[
                  `B:${rosterHand(row.bats)}`,
                  `T:${rosterHand(row.throws)}`,
                  ...row.positions
                ].join(' · ')}
              </Text>
              {row.userId == null && (
                <Text
                  style={{ ...text, color: theme.scoringSurface.mutedText }}
                >
                  Game-only player
                </Text>
              )}
            </View>
          </ScoringPlayerCard>
        ))}
      </ScrollView>
    </View>
  )
}
