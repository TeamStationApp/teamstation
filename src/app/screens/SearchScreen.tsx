import React, { useEffect, useRef, useState } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View
} from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { GroupRef } from '../../common/groupCreation'
import type {
  Location,
  SearchGroupResult,
  SearchResult
} from '../../common/search/types'
import type {
  SearchSocket,
  SearchSocketResults,
  SearchSocketStatus
} from '../../common/searchSocket'
import { Screen, useScreenBottom } from '../components'
import { ButtonIcon } from '../components/ButtonIcon'
import { LocationPill } from '../components/LocationPill'
import { useSceneReveals } from '../components/sceneShown'
import { useColumnSide } from '../components/Screen'
import { SearchResultRow } from '../components/SearchResultRow'
import { useTitleHandoff } from '../components/useTitleHandoff'
import {
  makeSearchSocket,
  openSearchSocket,
  type SearchSocketFactory
} from '../hooks/searchSocketFactory'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/** The field's placeholder, which is also its accessibility label. */
export const SEARCH_PLACEHOLDER = 'Search leagues, seasons, teams and people'

export type { SearchSocketFactory }

/** What the Search tab says once the server no longer takes the session. */
export const SEARCH_SIGNED_OUT_MESSAGE =
  'Your session has ended. Sign in again to search.'

/** The field's height before it is measured, and the gap above it. */
const FIELD_HEIGHT = 48
const FIELD_GAP = 12

/** A follow the reader changed here, until an answer asked later shows it. */
interface FollowChange {
  follow: 'follow' | 'following'
  /** Answers up to this `seq` predate it; Infinity while it is in flight. */
  through: number
}

const groupKey = (result: SearchGroupResult): string =>
  `${result.kind}:${result.id}`

/** A row's place, which tells two results of the same name apart. */
function placeOf(result: SearchResult): string | null {
  if (result.kind === 'person') return null
  if (result.cityLine != null) return result.cityLine
  // A league's associations are its city.
  return result.kind === 'league' && result.associations !== ''
    ? result.associations
    : null
}

/**
 * `Open <name>`, and `, <place>` after it only when another result on the
 * screen has the same name and this one has a place.
 */
export function openLabel(
  result: SearchResult,
  results: readonly SearchResult[]
): string {
  const place = placeOf(result)
  const shared = results.filter(other => other.name === result.name).length > 1
  return `Open ${result.name}${shared && place != null ? ', ' + place : ''}`
}

/**
 * The Search tab: one field that finds leagues, seasons, teams and people,
 * floating at the bottom (`docs/ui-rules.md`, "A search field floats at the
 * bottom").
 *
 * Every change to the text or the chosen location is asked over the search
 * socket at once. The server answers each with its lexicographic results,
 * and a second after the typing pauses with Jev's order, which replaces
 * them; an answer for older typing never reaches the screen. Suggested
 * location pills sit above the results; choosing one clears the text and
 * puts it in the field, and its X takes it out again.
 *
 * A socket the server closes for a session it no longer takes
 * (`unauthorized`) shows nothing found before and says to sign in again,
 * and tells the client as a REST 401 does (`onSessionRefused`).
 *
 * A group's Follow pill comes from the server's `follow`: absent signed out
 * and on the reader's own groups. A tap flips it at once and follows or
 * unfollows through the client, flipping back if that fails.
 */
export function SearchScreen({
  client,
  signedIn,
  onOpenGroup,
  onOpenPerson,
  follow = false,
  onFollowed,
  searchSocketFactory = openSearchSocket
}: {
  client: TeamStationClient
  /** Searches with the session's token; signed out, with none. */
  signedIn: boolean
  onOpenGroup: (ref: GroupRef) => void
  onOpenPerson: (userId: string, name: string) => void
  /** Opened from Home to find something to follow: says so. */
  follow?: boolean
  /** A Follow or Unfollow tap here has landed. */
  onFollowed?: () => void
  searchSocketFactory?: SearchSocketFactory
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const handoff = useTitleHandoff('Discover')
  const bottom = useScreenBottom()
  const side = useColumnSide()
  const reveals = useSceneReveals()
  const [text, setText] = useState('')
  const [location, setLocation] = useState<Location | null>(null)
  const [socket, setSocket] = useState<SearchSocket>()
  const [status, setStatus] = useState<SearchSocketStatus>('connecting')
  const [answer, setAnswer] = useState<SearchSocketResults>()
  const [error, setError] = useState('')
  const [changes, setChanges] = useState<ReadonlyMap<string, FollowChange>>(
    new Map()
  )
  const [followError, setFollowError] = useState('')
  const [fieldHeight, setFieldHeight] = useState(FIELD_HEIGHT)
  const latest = useRef(0)

  useEffect(() => {
    let made: SearchSocket
    try {
      made = makeSearchSocket(searchSocketFactory, client, signedIn)
    } catch {
      // No address or no WebSocket here: searching needs a connection.
      setStatus('offline')
      return
    }
    setStatus(made.status)
    const stops = [
      made.onStatus(next => {
        setStatus(next)
        // The server no longer takes the session: the app handles that as it
        // does a REST call's 401 (on the phone, by signing out, which
        // reopens this socket signed out).
        if (next === 'unauthorized') client.onSessionRefused?.()
      }),
      made.onResults(results => {
        // Only the latest ask is answered: one resent after a reconnect too.
        latest.current = Math.max(latest.current, results.seq)
        setAnswer(results)
        setError('')
      }),
      made.onError(refused => {
        setError(refused.message)
      })
    ]
    setSocket(made)
    return () => {
      for (const stop of stops) stop()
      made.close()
      setSocket(undefined)
    }
  }, [client, signedIn, searchSocketFactory])

  const empty = text.trim() === '' && location == null
  useEffect(() => {
    if (socket == null) return
    // Nothing asked yet and nothing to ask: no frame.
    if (empty && socket.latestSeq === 0) return
    latest.current = socket.search({ text, location, mode: 'all' })
    setError('')
    // Shown again after a page pushed over this one: ask afresh, so a follow
    // changed there shows here.
  }, [socket, text, location, empty, reveals])

  const answered = answer?.seq === latest.current
  const results = empty || answer == null ? [] : answer.results
  const suggestions =
    location != null || empty || answer == null ? [] : answer.locations

  const followOf = (
    result: SearchGroupResult
  ): FollowChange['follow'] | null => {
    if (result.follow == null) return null
    const change = changes.get(groupKey(result))
    return change != null && (answer?.seq ?? 0) <= change.through
      ? change.follow
      : result.follow
  }
  const setChange = (key: string, change: FollowChange | undefined): void => {
    setChanges(current => {
      const next = new Map(current)
      if (change == null) next.delete(key)
      else next.set(key, change)
      return next
    })
  }
  const toggle = (result: SearchGroupResult): void => {
    const key = groupKey(result)
    const was = followOf(result) === 'following'
    const ref = { kind: result.kind, id: result.id }
    const wanted = was ? 'follow' : 'following'
    setFollowError('')
    setChange(key, { follow: wanted, through: Infinity })
    ;(was
      ? client.unfollow(ref)
      : client.follow(ref).then(() => undefined)
    ).then(
      () => {
        // Answers to what is asked from here on know of it.
        setChange(key, { follow: wanted, through: socket?.latestSeq ?? 0 })
        onFollowed?.()
      },
      (failed: unknown) => {
        setChange(key, undefined)
        setFollowError(
          failed instanceof Error
            ? failed.message
            : `${result.name} could not be ${was ? 'unfollowed' : 'followed'}. Retry.`
        )
      }
    )
  }

  const signedOut = status === 'unauthorized'
  // Nothing found before is shown while searching cannot go on.
  const offline = status === 'offline' || signedOut
  return (
    <KeyboardAvoidingView
      behavior={
        Platform.OS === 'ios'
          ? 'padding'
          : Platform.OS === 'android'
            ? 'height'
            : undefined
      }
      style={styles.fill}
    >
      <Screen onScroll={handoff.handleScroll}>
        <View style={styles.page}>
          <View ref={handoff.ref} collapsable={false}>
            <Text style={styles.title} accessibilityRole="header">
              Discover
            </Text>
          </View>
          <Text style={styles.hint}>
            {follow
              ? 'Follow leagues, seasons and teams to keep them on your Home. A team opens on its own page, followed or not: its schedule, results and roster, with videos and player stats for its members.'
              : 'Find leagues, seasons, teams and people. Public profiles show location, parent organizations, schedules and results.'}
          </Text>
          {offline && (
            <Text accessibilityRole="alert" style={styles.hint}>
              {signedOut
                ? SEARCH_SIGNED_OUT_MESSAGE
                : 'Search needs a connection.'}
            </Text>
          )}
          {!offline && error !== '' && (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          )}
          {followError !== '' && (
            <Text accessibilityRole="alert" style={styles.error}>
              {followError}
            </Text>
          )}
          {!offline && suggestions.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              testID="location-suggestions"
              contentContainerStyle={styles.suggestions}
            >
              {suggestions.slice(0, 4).map(suggestion => (
                <LocationPill
                  key={suggestion.id}
                  label={suggestion.label}
                  onPress={() => {
                    setText('')
                    setLocation(suggestion)
                  }}
                />
              ))}
            </ScrollView>
          )}
          {!offline &&
            !empty &&
            answered &&
            error === '' &&
            results.length === 0 && (
              <Text style={styles.hint}>Nothing matches.</Text>
            )}
          {!offline &&
            results.map(result => {
              const label = openLabel(result, results)
              if (result.kind === 'person')
                return (
                  <SearchResultRow
                    key={`person:${result.userId}`}
                    result={result}
                    accessibilityLabel={label}
                    onPress={() => {
                      onOpenPerson(result.userId, result.name)
                    }}
                  />
                )
              const key = groupKey(result)
              return (
                <SearchResultRow
                  key={key}
                  result={result}
                  accessibilityLabel={label}
                  onPress={() => {
                    onOpenGroup({ kind: result.kind, id: result.id })
                  }}
                  follow={followOf(result)}
                  followBusy={changes.get(key)?.through === Infinity}
                  onToggleFollow={() => {
                    toggle(result)
                  }}
                />
              )
            })}
          {/* The last row clears the floating field. */}
          <View style={{ height: fieldHeight + FIELD_GAP }} />
        </View>
      </Screen>
      <View
        pointerEvents="box-none"
        style={[styles.dock, { bottom }]}
        onLayout={event => {
          setFieldHeight(event.nativeEvent.layout.height)
        }}
      >
        <View
          style={[
            styles.dockColumn,
            { paddingLeft: side.left, paddingRight: side.right }
          ]}
        >
          <View testID="Search field" style={styles.field}>
            <ButtonIcon
              name="search"
              size={1.25}
              color={theme.secondaryTextColor}
            />
            {location != null && (
              <LocationPill
                label={location.label}
                onRemove={() => {
                  setLocation(null)
                }}
              />
            )}
            <TextInput
              accessibilityLabel={SEARCH_PLACEHOLDER}
              placeholder={location == null ? SEARCH_PLACEHOLDER : undefined}
              placeholderTextColor={theme.placeholderTextColor}
              value={text}
              onChangeText={setText}
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
              style={styles.input}
            />
            {text !== '' && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear search"
                onPress={() => {
                  setText('')
                }}
                style={styles.clear}
              >
                <ButtonIcon
                  name="close"
                  size={1.125}
                  color={theme.secondaryTextColor}
                />
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </KeyboardAvoidingView>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  fill: { flex: 1 },
  page: { gap: theme.rem(1) },
  title: {
    fontSize: theme.rem(1.5),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  hint: {
    fontSize: theme.rem(0.875),
    lineHeight: theme.rem(1.35),
    color: theme.secondaryTextColor
  },
  error: { fontSize: theme.rem(0.875), color: theme.dangerColor },
  suggestions: { flexDirection: 'row' as const, gap: theme.rem(0.5) },
  dock: {
    position: 'absolute' as const,
    left: 0,
    right: 0,
    alignItems: 'center' as const
  },
  dockColumn: {
    width: '100%' as const,
    maxWidth: theme.rem(theme.maxContentWidthRem)
  },
  field: {
    minHeight: FIELD_HEIGHT,
    paddingLeft: 14,
    paddingRight: 4,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
    borderRadius: FIELD_HEIGHT / 2,
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    backgroundColor: theme.cardBackgroundColor,
    shadowColor: theme.shadowColor,
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5
  },
  // The input takes all the width the pill leaves, up to the clear button,
  // and never less than 25% of the field: past that the pill's label
  // ellipsizes instead. Longer text scrolls to the caret.
  input: {
    flexGrow: 1,
    flexShrink: 0,
    flexBasis: 0,
    minWidth: '25%' as const,
    paddingHorizontal: 0,
    minHeight: 44,
    color: theme.inputTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: 16
  },
  clear: {
    width: 44,
    height: 44,
    alignItems: 'center' as const,
    justifyContent: 'center' as const
  }
}))
