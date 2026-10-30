import { LegendList } from '@legendapp/list/react-native'
import React, { useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  useWindowDimensions,
  View
} from 'react-native'
import { initialWindowMetrics } from 'react-native-safe-area-context'

import type { RosterCandidate, TeamStationClient } from '../../common/api'
import { useRosterCandidates } from '../hooks/useRosterCandidates'
import { ScoringCandidateCard } from './ScoringCandidateCard'
import { ScoringPlayerSearchField } from './ScoringPlayerSearchField'
import { ScoringSheet } from './ScoringSheet'
import { useScoringSheetTheme } from './scoringSheetTheme'

/** The home indicator's inset, which the keyboard covers. */
const KEYBOARD_INSET = initialWindowMetrics?.insets.bottom ?? 0
/** The field's height before it is measured, and the gap above it. */
const FIELD_HEIGHT = 48
const FIELD_GAP = 12

/**
 * Add Existing Player: a full-screen sheet over the game listing the players
 * a roster manager may add to this side's team, nearest first, searched by
 * the field floating at the bottom. Choosing one closes nothing by itself;
 * the caller opens Add to Roster for them.
 */
export function ExistingPlayerSheet({
  client,
  teamId,
  gameId,
  onChoose,
  onClose,
  children
}: {
  client: TeamStationClient
  teamId: string
  gameId?: string
  onChoose: (candidate: RosterCandidate) => void
  onClose: () => void
  /** A sheet opened over this one, such as Add to Roster for the choice. */
  children?: React.ReactNode
}): React.ReactElement {
  const theme = useScoringSheetTheme()
  const surface = theme.scoringSurface
  const [query, setQuery] = useState('')
  const [fieldHeight, setFieldHeight] = useState(FIELD_HEIGHT)
  const list = useRosterCandidates({ client, teamId, gameId, query })
  const covered = React.Children.toArray(children).length > 0
  const window = useWindowDimensions()
  const line = {
    color: surface.secondaryText,
    fontFamily: theme.regularTextFont,
    fontSize: 14,
    textAlign: 'center' as const,
    paddingVertical: 24,
    paddingHorizontal: 12
  }
  const retry = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Retry"
      onPress={() => {
        list.retry()
      }}
      style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'center' }}
    >
      <Text
        style={{
          color: surface.accent,
          fontFamily: theme.semiBoldTextFont,
          fontSize: 14
        }}
      >
        Retry
      </Text>
    </Pressable>
  )
  const problem = (message: string): React.ReactElement => (
    <View>
      <Text accessibilityRole="alert" style={line}>
        {message}
      </Text>
      {retry}
    </View>
  )

  let empty: React.ReactElement | null = null
  if (list.offline)
    empty = <Text style={line}>Searching needs a connection.</Text>
  else if (list.loading)
    empty = (
      <ActivityIndicator
        testID="Candidates loading"
        color={surface.accent}
        style={{ paddingVertical: 24 }}
      />
    )
  else if (list.error != null && list.rows.length === 0)
    empty = problem(list.error)
  else if (list.query === '')
    empty = (
      <Text style={line}>
        No players on your teams, season or league yet. Type three letters to
        search all players.
      </Text>
    )
  else empty = <Text style={line}>No players match “{list.query}”.</Text>

  const footer =
    list.rows.length === 0 ? null : list.loadingMore ? (
      <ActivityIndicator
        testID="Candidates loading more"
        color={surface.accent}
        style={{ paddingVertical: 16 }}
      />
    ) : list.error != null ? (
      problem(list.error)
    ) : null

  return (
    <ScoringSheet
      title="Add Existing Player"
      fullScreen
      // Wider than the app's content column, a sheet of that column's width.
      maxWidth={theme.rem(theme.maxContentWidthRem)}
      scroll={false}
      textCancel
      onClose={onClose}
      // The sheet's own bottom inset and padding are under the keyboard
      // while it is up: the field rides just above it.
      keyboardVerticalOffset={-(KEYBOARD_INSET + 16 - FIELD_GAP)}
    >
      {/* The sheet pads itself for the keyboard on iOS. Android does not
          shrink the window for it, so the list and field shrink here
          (`height`), as `TessChat` does. */}
      <KeyboardAvoidingView
        behavior={Platform.OS === 'android' ? 'height' : undefined}
        style={{ flex: 1 }}
      >
        <View testID="Candidate list" style={{ flex: 1 }}>
          <LegendList
            data={list.offline ? [] : list.rows}
            keyExtractor={candidate => candidate.userId}
            renderItem={({ item }) => (
              <ScoringCandidateCard
                candidate={item}
                onPress={() => {
                  onChoose(item)
                }}
              />
            )}
            recycleItems
            estimatedItemSize={72}
            onEndReachedThreshold={0.5}
            onEndReached={() => {
              if (list.error == null) list.loadMore()
            }}
            // On the web this is a DOM list, which has no keyboard to keep.
            {...(Platform.OS === 'web'
              ? {}
              : { keyboardShouldPersistTaps: 'handled' as const })}
            // Rows draw before the list has measured itself.
            estimatedListSize={{ height: window.height, width: window.width }}
            ListEmptyComponent={empty}
            ListFooterComponent={footer}
            contentContainerStyle={{ paddingBottom: fieldHeight + FIELD_GAP }}
            style={{ flex: 1 }}
          />
        </View>
        {/* The sheet over this one is translucent: the field would show
            through it. */}
        {!covered && (
          <View
            onLayout={event => {
              setFieldHeight(event.nativeEvent.layout.height)
            }}
            style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}
          >
            <ScoringPlayerSearchField
              value={query}
              onChangeText={setQuery}
              disabled={list.offline}
            />
          </View>
        )}
      </KeyboardAvoidingView>
      {children}
    </ScoringSheet>
  )
}
