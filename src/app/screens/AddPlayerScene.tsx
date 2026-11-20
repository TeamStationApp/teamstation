import { LegendList } from '@legendapp/list/react-native'
import React, { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Platform,
  Pressable,
  SafeAreaView as WebSafeAreaView,
  type StyleProp,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle
} from 'react-native'
import {
  initialWindowMetrics,
  SafeAreaProvider,
  SafeAreaView,
  useSafeAreaInsets
} from 'react-native-safe-area-context'

import {
  ROSTER_CANDIDATE_MAX,
  type RosterCandidate,
  type TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { playerAddToldWords } from '../../common/notifications'
import {
  emptyPlayerForm,
  playerFormError,
  type PlayerFormValue
} from '../../common/playerForm'
import { PLAYER_POSITIONS } from '../../common/playerSettings'
import { Button, Card } from '../components'
import { CandidateCard } from '../components/CandidateCard'
import { useKeyboardControllerHeld } from '../components/keyboardControllerOwner'
import { Modal } from '../components/Modal'
import { PlayerForm } from '../components/PlayerForm'
import { SEARCH_FIELD_HEIGHT, SearchField } from '../components/SearchField'
import { useRosterCandidates } from '../hooks/useRosterCandidates'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { KeyboardForm } from './KeyboardForm'
import { dismissKeyboard } from './SearchDock'
import {
  SEARCH_FIELD_GAP,
  SearchFieldClearance,
  SearchFieldDock,
  searchFieldOnTop
} from './SearchFieldDock'

/**
 * The scene's safe area: on the web the browser's own (CSS env()), which
 * does not measure a sliding portal; on a phone safe-area-context's, which
 * leaves the foot of the screen to the dock (`edges`). Chosen as it draws.
 */
function SceneArea({
  style,
  children
}: {
  style: StyleProp<ViewStyle>
  children: React.ReactNode
}): React.ReactElement {
  return Platform.OS === 'web' ? (
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the web's needs no measuring; native uses safe-area-context.
    <WebSafeAreaView style={style}>{children}</WebSafeAreaView>
  ) : (
    <SafeAreaView style={style} edges={['top', 'left', 'right']}>
      {children}
    </SafeAreaView>
  )
}

/** Search's dock, clear of the modal's own home indicator, live. */
function InsetDock(
  props: Omit<React.ComponentProps<typeof SearchFieldDock>, 'bottom'>
): React.ReactElement {
  const insets = useSafeAreaInsets()
  return (
    <SearchFieldDock bottom={insets.bottom + SEARCH_FIELD_GAP} {...props} />
  )
}

/** The room under the last candidate: the dock, its gap and the home indicator. */
function InsetClearance({
  dockHeight
}: {
  dockHeight: number
}): React.ReactElement {
  const insets = useSafeAreaInsets()
  return <SearchFieldClearance dockHeight={dockHeight} under={insets.bottom} />
}

/**
 * Team settings' Add Player: a scene that slides up over team settings,
 * listing the players a roster manager may put on the team, nearest first,
 * searched by Search's own field (`SearchField`): at the top in a browser,
 * and on a phone or tablet docked at the bottom, riding the keyboard up and
 * down as Search's does (`SearchFieldDock`); a drag of the list puts the
 * keyboard away. It finds players only. Choosing one shows Add to
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
  const [dockHeight, setDockHeight] = useState(SEARCH_FIELD_HEIGHT)
  const [chosen, setChosen] = useState<RosterCandidate>()
  const [value, setValue] = useState<PlayerFormValue>(emptyPlayerForm)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)
  const saving = useRef(false)
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    []
  )
  // On Android the keyboard controller must be on before the modal shows,
  // or it never attaches to the modal's window and the dock cannot ride the
  // keyboard: held here, for as long as the scene is up.
  const held = useKeyboardControllerHeld()
  const list = useRosterCandidates({ client, teamId, query })
  const contentWidth = theme.rem(theme.maxContentWidthRem)
  const wide = window.width > contentWidth

  const choose = (candidate: RosterCandidate): void => {
    // The list's keyboard goes away with its own animation as the form comes
    // in, rather than standing over a form that has not asked for it.
    dismissKeyboard()
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
    if (saving.current || problem != null) return
    saving.current = true
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
      if (!mounted.current) return
      if ('pendingRequestId' in answer) setPending(true)
      else
        onAdded(
          answer.unchanged === true
            ? `${candidate.shortName} is already on the roster`
            : answer.noticeId == null
              ? `Added ${candidate.shortName} to the roster`
              : `Added ${candidate.shortName} to the roster. ${playerAddToldWords(answer.told)}`
        )
    } catch (caught) {
      setError(
        caught instanceof HttpError
          ? caught.message
          : 'Unable to add the player. Please try again.'
      )
    } finally {
      saving.current = false
      setBusy(false)
    }
  }
  // Back or Esc does what Cancel does, and waits for an add as Cancel does.
  const back = (): void => {
    if (busy) return
    if (chosen == null) onCancel()
    else setChosen(undefined)
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
  const top = searchFieldOnTop()
  const more =
    list.rows.length === 0 ? null : list.updating ? (
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
    ) : list.capped ? (
      line(sprintf(lstrings.candidates_capped, ROSTER_CANDIDATE_MAX))
    ) : null
  // The last row clears the floating dock, and the keyboard.
  const footer = top ? (
    more
  ) : (
    <>
      {more}
      <InsetClearance dockHeight={dockHeight} />
    </>
  )
  const field = (
    <SearchField
      testID="Player search field"
      placeholder="Search players"
      value={query}
      onChangeText={setQuery}
      disabled={list.offline}
      autoCapitalize="words"
    />
  )

  if (!held) return <></>
  return (
    <Modal
      visible
      transparent={wide}
      animationType="slide"
      onRequestClose={back}
    >
      <SafeAreaProvider
        initialMetrics={
          initialWindowMetrics ?? {
            frame: { x: 0, y: 0, width: 0, height: 0 },
            insets: { top: 0, bottom: 0, left: 0, right: 0 }
          }
        }
      >
        <View
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
                    back()
                  }}
                  style={styles.cancel}
                >
                  <Text style={styles.cancelText}>Cancel</Text>
                </Pressable>
              </View>
              {chosen == null ? (
                <View style={styles.body}>
                  {top && <View style={styles.topField}>{field}</View>}
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
                      // As Search's list: a drag puts the keyboard away
                      // through the keyboard controller, whose dismissal the
                      // dock follows; iOS insets the list by the keyboard.
                      {...(top
                        ? {}
                        : {
                            onScrollBeginDrag: dismissKeyboard,
                            automaticallyAdjustKeyboardInsets: true
                          })}
                      style={{ flex: 1 }}
                    />
                  </View>
                  {!top && (
                    <InsetDock
                      active
                      side={{ left: theme.rem(1), right: theme.rem(1) }}
                      field={field}
                      onHeight={setDockHeight}
                    />
                  )}
                </View>
              ) : (
                <KeyboardForm style={styles.form}>
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
                      This needs approval first. We sent the request.
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
                </KeyboardForm>
              )}
            </View>
          </SceneArea>
        </View>
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
  topField: { paddingTop: theme.rem(0.25), paddingBottom: theme.rem(1) },
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
