import { LegendList } from '@legendapp/list/react-native'
import React, { useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView as WebSafeAreaView,
  ScrollView,
  Text,
  useWindowDimensions,
  View
} from 'react-native'
import {
  initialWindowMetrics,
  SafeAreaProvider,
  SafeAreaView
} from 'react-native-safe-area-context'

import type { RosterCandidate, TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import {
  emptyPlayerForm,
  playerFormError,
  type PlayerFormValue
} from '../../common/playerForm'
import { PLAYER_POSITIONS } from '../../common/playerSettings'
import { Button, Card } from '../components'
import { CandidateCard } from '../components/CandidateCard'
import { PlayerForm } from '../components/PlayerForm'
import { PlayerSearchField } from '../components/PlayerSearchField'
import { useRosterCandidates } from '../hooks/useRosterCandidates'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

// eslint-disable-next-line @typescript-eslint/no-deprecated -- Web implementation uses CSS env() and avoids measuring a sliding portal. Native uses safe-area-context.
const SceneArea = Platform.OS === 'web' ? WebSafeAreaView : SafeAreaView

/** The field's height before it is measured, and the gap above it. */
const FIELD_HEIGHT = 48
const FIELD_GAP = 12

/**
 * Team settings' Add Player: a scene that slides up over team settings,
 * listing the players a roster manager may put on the team, nearest first,
 * searched by the field floating at the bottom. Choosing one shows Add to
 * Roster in the same scene: their short name and hands greyed, the jersey
 * and positions theirs to set. There is no pool player here: that is a
 * game's. Cancel changes nothing.
 *
 * Wider than the app's content column, it is a sheet of that column's width
 * over team settings, as team settings' own cards are; narrower, the whole
 * screen.
 */
export function AddPlayerScene({
  client,
  teamId,
  onAdded,
  onCancel
}: {
  client: TeamStationClient
  teamId: string
  /** The player went on the roster: the line team settings shows for it. */
  onAdded: (message: string) => void
  onCancel: () => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const window = useWindowDimensions()
  const [query, setQuery] = useState('')
  const [fieldHeight, setFieldHeight] = useState(FIELD_HEIGHT)
  const [chosen, setChosen] = useState<RosterCandidate>()
  const [value, setValue] = useState<PlayerFormValue>(emptyPlayerForm)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)
  const list = useRosterCandidates({ client, teamId, query })
  const contentWidth = theme.rem(theme.maxContentWidthRem)
  const wide = window.width > contentWidth

  const choose = (candidate: RosterCandidate): void => {
    setChosen(candidate)
    setValue({
      ...emptyPlayerForm(),
      firstName: candidate.shortParts.first,
      lastName: candidate.shortParts.last,
      throws: candidate.throws,
      bats: candidate.bats
    })
    setError(undefined)
    setPending(false)
  }
  const problem = playerFormError(value, { nameRequired: false })
  const add = async (candidate: RosterCandidate): Promise<void> => {
    if (busy || problem != null) return
    setBusy(true)
    setError(undefined)
    try {
      const jersey = value.jersey.trim()
      const answer = await client.addExistingRosterPlayer(teamId, {
        userId: candidate.userId,
        jersey: jersey === '' ? null : jersey,
        positions: PLAYER_POSITIONS.filter(position =>
          value.positions.includes(position)
        )
      })
      if ('pendingRequestId' in answer) setPending(true)
      else
        onAdded(
          answer.noticeId == null
            ? `Added ${candidate.shortName} to the roster`
            : `Added ${candidate.shortName} to the roster. Their guardians were notified.`
        )
    } catch (caught) {
      setError(
        caught instanceof HttpError
          ? caught.message
          : 'Unable to add the player. Please try again.'
      )
    } finally {
      setBusy(false)
    }
  }

  const line = (message: string): React.ReactElement => (
    <Text style={styles.line}>{message}</Text>
  )
  let empty: React.ReactElement
  if (list.offline) empty = line('Searching needs a connection.')
  else if (list.loading)
    empty = (
      <ActivityIndicator
        testID="Candidates loading"
        color={theme.activeColor}
        style={{ paddingVertical: 24 }}
      />
    )
  else if (list.error != null && list.rows.length === 0)
    empty = (
      <View>
        <Text accessibilityRole="alert" style={styles.line}>
          {list.error}
        </Text>
        <Button
          label="Retry"
          accessibilityLabel="Retry"
          onPress={() => {
            list.retry()
          }}
        />
      </View>
    )
  else if (list.query === '')
    empty = line(
      'No players on your teams, season or league yet. Type three letters to search all players.'
    )
  else empty = line(`No players match “${list.query}”.`)
  const footer =
    list.rows.length === 0 ? null : list.loadingMore ? (
      <ActivityIndicator
        testID="Candidates loading more"
        color={theme.activeColor}
        style={{ paddingVertical: 16 }}
      />
    ) : list.error != null ? (
      <View>
        <Text accessibilityRole="alert" style={styles.line}>
          {list.error}
        </Text>
        <Button
          label="Retry"
          accessibilityLabel="Retry"
          onPress={() => {
            list.retry()
          }}
        />
      </View>
    ) : null

  return (
    <Modal
      visible
      transparent={wide}
      animationType="slide"
      onRequestClose={onCancel}
    >
      <SafeAreaProvider
        initialMetrics={
          initialWindowMetrics ?? {
            frame: { x: 0, y: 0, width: 0, height: 0 },
            insets: { top: 0, bottom: 0, left: 0, right: 0 }
          }
        }
      >
        {/* iOS pads by the keyboard's height; Android does not shrink the
            window for it, so the scene shrinks itself, as `TessChat` does. */}
        <KeyboardAvoidingView
          behavior={
            Platform.OS === 'ios'
              ? 'padding'
              : Platform.OS === 'android'
                ? 'height'
                : undefined
          }
          // The home indicator's inset is under the keyboard while it is up:
          // the field rides just above it.
          keyboardVerticalOffset={-(initialWindowMetrics?.insets.bottom ?? 0)}
          style={
            Platform.OS === 'web'
              ? { height: '100dvh', width: '100%' }
              : { flex: 1 }
          }
        >
          <SceneArea style={wide ? styles.backdropArea : styles.scene}>
            {wide && (
              <Pressable
                accessibilityLabel="Dismiss Add Player"
                disabled={busy}
                onPress={onCancel}
                style={styles.backdrop}
              />
            )}
            <View
              testID="Add Player panel"
              style={
                wide ? [styles.panel, { width: contentWidth }] : styles.fill
              }
            >
              <View style={styles.header}>
                <Text accessibilityRole="header" style={styles.title}>
                  {chosen == null ? 'Add Player' : 'Add to Roster'}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Cancel"
                  disabled={busy}
                  onPress={() => {
                    if (chosen == null) onCancel()
                    else setChosen(undefined)
                  }}
                  style={styles.cancel}
                >
                  <Text style={styles.cancelText}>Cancel</Text>
                </Pressable>
              </View>
              {chosen == null ? (
                <View style={styles.body}>
                  <View testID="Candidate list" style={{ flex: 1 }}>
                    <LegendList
                      data={list.offline ? [] : list.rows}
                      keyExtractor={candidate => candidate.userId}
                      renderItem={({ item }) => (
                        <CandidateCard
                          candidate={item}
                          onPress={() => {
                            choose(item)
                          }}
                        />
                      )}
                      recycleItems
                      estimatedItemSize={72}
                      onEndReachedThreshold={0.5}
                      onEndReached={() => {
                        if (list.error == null) list.loadMore()
                      }}
                      // On the web this is a DOM list, which has no keyboard
                      // to keep.
                      {...(Platform.OS === 'web'
                        ? {}
                        : { keyboardShouldPersistTaps: 'handled' as const })}
                      // Rows draw before the list has measured itself.
                      estimatedListSize={{
                        height: window.height,
                        width: window.width
                      }}
                      ListEmptyComponent={empty}
                      ListFooterComponent={footer}
                      contentContainerStyle={{
                        paddingBottom: fieldHeight + FIELD_GAP
                      }}
                      style={{ flex: 1 }}
                    />
                  </View>
                  <View
                    onLayout={event => {
                      setFieldHeight(event.nativeEvent.layout.height)
                    }}
                    style={styles.field}
                  >
                    <PlayerSearchField
                      value={query}
                      onChangeText={setQuery}
                      disabled={list.offline}
                    />
                  </View>
                </View>
              ) : (
                <ScrollView
                  keyboardShouldPersistTaps="handled"
                  contentContainerStyle={styles.form}
                >
                  <Card>
                    <PlayerForm
                      value={value}
                      onChange={setValue}
                      disabled={busy || pending}
                      fields={{
                        name: 'readOnly',
                        hands: 'readOnly',
                        jersey: true,
                        positions: true
                      }}
                    />
                  </Card>
                  {pending && (
                    <Text accessibilityRole="alert" style={styles.note}>
                      This needs a guardian's approval first. We sent the
                      request.
                    </Text>
                  )}
                  {(error ?? problem) != null && (
                    <Text accessibilityRole="alert" style={styles.error}>
                      {error ?? problem}
                    </Text>
                  )}
                  <Button
                    label="Add to Roster"
                    accessibilityLabel="Add to Roster"
                    busy={busy}
                    disabled={busy || pending || problem != null}
                    onPress={() => {
                      add(chosen).catch(() => undefined)
                    }}
                  />
                </ScrollView>
              )}
            </View>
          </SceneArea>
        </KeyboardAvoidingView>
      </SafeAreaProvider>
    </Modal>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  scene: { flex: 1, backgroundColor: theme.backgroundColor },
  backdropArea: { flex: 1 },
  backdrop: {
    position: 'absolute' as const,
    inset: 0,
    backgroundColor: theme.overlayBackgroundColor
  },
  fill: { flex: 1 },
  /** The content column's width, centred, as a sheet risen from below. */
  panel: {
    flex: 1,
    alignSelf: 'center' as const,
    marginTop: theme.rem(1.5),
    overflow: 'hidden' as const,
    backgroundColor: theme.backgroundColor,
    borderTopLeftRadius: theme.rem(theme.radiusLargeRem),
    borderTopRightRadius: theme.rem(theme.radiusLargeRem)
  },
  header: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    paddingHorizontal: theme.rem(1),
    paddingTop: theme.rem(0.75),
    paddingBottom: theme.rem(0.5),
    gap: theme.rem(0.75)
  },
  title: {
    flex: 1,
    fontSize: theme.rem(1.5),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  cancel: {
    minHeight: 44,
    paddingHorizontal: 10,
    justifyContent: 'center' as const
  },
  cancelText: { fontFamily: theme.semiBoldTextFont, color: theme.dangerColor },
  body: { flex: 1, paddingHorizontal: theme.rem(1) },
  field: {
    position: 'absolute' as const,
    left: theme.rem(1),
    right: theme.rem(1),
    bottom: FIELD_GAP
  },
  form: { padding: theme.rem(1), gap: theme.rem(1) },
  line: {
    paddingVertical: 24,
    paddingHorizontal: 12,
    textAlign: 'center' as const,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  note: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.primaryTextColor
  },
  error: { fontSize: theme.rem(0.875), color: theme.dangerColor }
}))
