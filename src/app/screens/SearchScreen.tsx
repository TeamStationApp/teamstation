import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ScrollView, Text, View } from 'react-native'

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
import { LocationPill } from '../components/LocationPill'
import { useSceneReveals, useSceneShown } from '../components/sceneShown'
import { useColumnSide } from '../components/Screen'
import { SEARCH_FIELD_HEIGHT, SearchField } from '../components/SearchField'
import { SearchResultRow } from '../components/SearchResultRow'
import { useTitleHandoff } from '../components/useTitleHandoff'
import {
  makeSearchSocket,
  openSearchSocket,
  type SearchSocketFactory
} from '../hooks/searchSocketFactory'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { dismissKeyboard } from './SearchDock'
import {
  SearchFieldClearance,
  SearchFieldDock,
  searchFieldOnTop
} from './SearchFieldDock'

/** Room for a raised pill's shadow: its 8-point blur and a little more. */
const SHADOW_GUTTER = 12

/** The field's placeholder, which is also its accessibility label. */
export const SEARCH_PLACEHOLDER = 'Search leagues, seasons, teams and people'

export type { SearchSocketFactory }

/** What the Search tab says once the server no longer takes the session. */
export const SEARCH_SIGNED_OUT_MESSAGE =
  'Your session has ended. Sign in again to search.'

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
 * floating at the bottom on a phone or tablet and at the top in a browser
 * (`docs/ui-rules.md`, "A search field floats at the bottom").
 *
 * Every change to the text or the chosen location is asked over the search
 * socket at once. The server answers each with its lexicographic results,
 * and a second after the typing pauses with Jev's order, which replaces
 * them; an answer for older typing never reaches the screen. Suggested
 * location pills sit right next to the field: under it in a browser, above it
 * in the dock on a phone or tablet, where the dock rides the keyboard and a
 * drag of the results puts the keyboard away (`SearchDock`). Choosing one
 * clears the text and puts it in the field, and its X takes it out again.
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
  const shown = useSceneShown()
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
  const [dockHeight, setDockHeight] = useState(SEARCH_FIELD_HEIGHT)
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
  // A browser has no keyboard to rise over and a pointer is not a thumb: the
  // field sits at the top there, under the title, with its pills under it.
  const top = searchFieldOnTop()
  // The same place between keystrokes, so typing redraws no pill.
  const place = useMemo(
    () =>
      location == null
        ? null
        : {
            label: location.label,
            onRemove: () => {
              setLocation(null)
            }
          },
    [location]
  )
  const field = (
    <SearchField
      testID="Search field"
      placeholder={SEARCH_PLACEHOLDER}
      value={text}
      onChangeText={setText}
      place={place}
    />
  )
  const pills = !offline && suggestions.length > 0 && (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      testID="location-suggestions"
      style={styles.suggestionsBleed}
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
  )
  return (
    <View style={styles.fill}>
      <Screen
        onScroll={handoff.handleScroll}
        // `Screen` already drops the keyboard on a drag; this puts it away
        // through the keyboard controller, whose dismissal the dock follows
        // frame by frame on Android too.
        onScrollBeginDrag={top ? undefined : dismissKeyboard}
      >
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
          {top && field}
          {top && pills}
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
          {/* The last row clears the floating dock, and the keyboard. */}
          {!top && <SearchFieldClearance dockHeight={dockHeight} />}
        </View>
      </Screen>
      {!top && (
        <SearchFieldDock
          bottom={bottom}
          active={shown}
          side={side}
          field={field}
          pills={pills}
          onHeight={setDockHeight}
        />
      )}
    </View>
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
  // The row is a finger's 44 points tall, the 20-point pills centred in it:
  // a scroll view clips touches to its bounds, so their reach above and below
  // (`hitSlop`) has to fall inside it.
  // The pills' shadows reach past their row's ends, where a scroll view
  // clips: the row reaches into a gutter as wide as the shadow on each side,
  // and pads it back, so the pills still line up with the field.
  suggestionsBleed: {
    marginHorizontal: -SHADOW_GUTTER
  },
  suggestions: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.rem(0.5),
    minHeight: 44,
    paddingHorizontal: SHADOW_GUTTER
  }
}))
