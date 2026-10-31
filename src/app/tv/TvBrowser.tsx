import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as ReactNative from 'react-native'
import { Defs, LinearGradient, Rect, Stop, Svg } from 'react-native-svg'

import type {
  TeamStationClient,
  TeamSummary,
  UserMatch,
  VideoGame
} from '../../common/api'
import { fourAcross, gameDate, monthSections } from './browseLayout'
import { loadTvCollection, type TvClip, type TvCollection } from './collections'
import { tvControl } from './remote'
import { TvButton } from './TvButton'

const {
  BackHandler,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View
} = ReactNative
const FocusGuide =
  (
    ReactNative as unknown as {
      TVFocusGuideView?: React.ComponentType<
        React.ComponentProps<typeof View> & { autoFocus?: boolean }
      >
    }
  ).TVFocusGuideView ?? View

export type TvPage =
  | { kind: 'home' }
  | { kind: 'team'; team: TeamSummary }
  | { kind: 'player'; player: UserMatch }
export interface TvPlayRequest {
  game: VideoGame
  clip?: TvClip
}
const pageKey = (page: TvPage): string =>
  page.kind === 'home'
    ? 'home'
    : page.kind === 'team'
      ? page.team.id
      : page.player.userId

export function TvScrim({
  header = false
}: {
  header?: boolean
}): React.ReactElement {
  return (
    <Svg
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      width="100%"
      height="100%"
    >
      <Defs>
        <LinearGradient id="left" x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor="#454545" />
          <Stop offset="0.45" stopColor="#454545" stopOpacity={0.88} />
          <Stop offset="0.8" stopColor="#454545" stopOpacity={0.08} />
        </LinearGradient>
        <LinearGradient id="bottom" x1="0" y1="0" x2="0" y2="1">
          <Stop
            offset={header ? '0' : '0.3'}
            stopColor={header ? '#171717' : '#454545'}
            stopOpacity={header ? 0.98 : 0}
          />
          <Stop
            offset="1"
            stopColor={header ? '#171717' : '#454545'}
            stopOpacity={header ? 0 : 1}
          />
        </LinearGradient>
      </Defs>
      {!header && <Rect width="100%" height="100%" fill="url(#left)" />}
      <Rect width="100%" height="100%" fill="url(#bottom)" />
    </Svg>
  )
}

function Tile({
  id,
  image,
  title,
  detail,
  width,
  preferred,
  onPress,
  onFocus
}: {
  id: string
  image: string | null
  title: string
  detail?: string
  width: number
  preferred: boolean
  onPress: () => void
  onFocus: (id: string) => void
}): React.ReactElement {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      testID={id}
      accessibilityRole="button"
      accessibilityLabel={`${title}${detail === undefined ? '' : `, ${detail}`}`}
      {...{ hasTVPreferredFocus: preferred }}
      onFocus={() => {
        setFocused(true)
        onFocus(id)
      }}
      onBlur={() => {
        setFocused(false)
      }}
      onPress={onPress}
      style={[styles.tile, { width }, focused && styles.tileFocus]}
    >
      <View style={[styles.thumbnail, { height: (width * 9) / 16 }]}>
        {image === null ? (
          <Text style={styles.placeholder}>▶</Text>
        ) : (
          <Image
            source={{ uri: image }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
          />
        )}
      </View>
      <Text numberOfLines={1} style={styles.tileTitle}>
        {title}
      </Text>
      {detail !== undefined && (
        <Text numberOfLines={1} style={styles.tileDetail}>
          {detail}
        </Text>
      )}
    </Pressable>
  )
}

export function TvBrowser({
  client,
  onPlay,
  onSignOut,
  viewerName,
  visible = true
}: {
  client: TeamStationClient
  onPlay: (request: TvPlayRequest) => void
  onSignOut: () => void
  viewerName: string
  visible?: boolean
}): React.ReactElement {
  const [pages, setPages] = useState<TvPage[]>([{ kind: 'home' }])
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(false)
  const [results, setResults] = useState<{
    teams: TeamSummary[]
    players: UserMatch[]
  } | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const active = pages.length - 1
  const open = (page: TvPage): void => {
    setQuery('')
    setPages(current => [...current, page])
  }
  const back = useCallback((): void => {
    if (query !== '') setQuery('')
    else
      setPages(current => (current.length > 1 ? current.slice(0, -1) : current))
  }, [query])
  useEffect(() => {
    if (editing) {
      tvControl?.disableTVMenuKey()
      return
    }
    if (!visible || (query === '' && pages.length === 1)) return
    tvControl?.enableTVMenuKey()
    return () => tvControl?.disableTVMenuKey()
  }, [visible, query, pages.length, editing])
  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        if (visible && !editing && (query !== '' || pages.length > 1)) {
          back()
          return true
        }
        return false
      }
    )
    return () => {
      subscription.remove()
    }
  }, [back, query, pages.length, visible, editing])
  useEffect(() => {
    let current = true
    setResults(null)
    setSearchError(null)
    if (query.trim() === '') return
    const timer = setTimeout(() => {
      Promise.all([
        client.videoTeams({ q: query.trim(), limit: 20 }),
        client.videoPlayers({ q: query.trim(), limit: 20 })
      ])
        .then(([teams, players]) => {
          if (current) setResults({ teams, players })
        })
        .catch(() => {
          if (current) setSearchError('Search is unavailable. Try again.')
        })
    }, 500)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [client, query, retry])
  return (
    <View style={styles.scene}>
      <FocusGuide key={active} autoFocus style={styles.toolbar}>
        {active > 0 ? (
          <TvButton label="Back" onPress={back} />
        ) : (
          <Text style={styles.brand}>TeamStation TV</Text>
        )}
        <Text style={styles.welcome}>Welcome, {viewerName}</Text>
        <TextInput
          testID="tv-search"
          accessibilityLabel="Search teams or players"
          placeholder="Search teams or players"
          placeholderTextColor="#bbb"
          value={query}
          onChangeText={setQuery}
          onFocus={() => {
            setEditing(true)
          }}
          onBlur={() => {
            setEditing(false)
          }}
          autoCorrect={false}
          style={styles.search}
        />
        <TvButton label="Sign out" onPress={onSignOut} />
      </FocusGuide>
      {pages.map((page, index) => (
        <View
          key={`${index}-${pageKey(page)}`}
          style={[
            styles.page,
            (index !== active || query.trim() !== '') && styles.hidden
          ]}
        >
          <BrowsePage
            client={client}
            page={page}
            active={visible && index === active && query === ''}
            onOpen={open}
            onPlay={onPlay}
          />
        </View>
      ))}
      {query.trim() !== '' && (
        <ScrollView
          testID="tv-search-results"
          style={styles.searchResults}
          contentContainerStyle={styles.searchContent}
        >
          <Text style={styles.heading}>Search</Text>
          <TvButton
            label="Close search"
            onPress={() => {
              setQuery('')
            }}
          />
          {searchError !== null ? (
            <>
              <Text style={styles.copy}>{searchError}</Text>
              <TvButton
                label="Retry search"
                onPress={() => {
                  setRetry(n => n + 1)
                }}
              />
            </>
          ) : results === null ? (
            <Text style={styles.copy}>Searching…</Text>
          ) : (
            <>
              {results.teams.length === 0 && results.players.length === 0 && (
                <Text style={styles.copy}>
                  No accessible teams or players found.
                </Text>
              )}
              {results.teams.length > 0 && (
                <Text style={styles.heading}>Teams</Text>
              )}
              {results.teams.map(team => (
                <SearchRow
                  key={team.id}
                  label={team.name}
                  image={team.logoUrl}
                  onPress={() => {
                    open({ kind: 'team', team })
                  }}
                />
              ))}
              {results.players.length > 0 && (
                <Text style={styles.heading}>Players</Text>
              )}
              {results.players.map(player => (
                <SearchRow
                  key={player.userId}
                  label={player.shortName ?? 'Player'}
                  image={player.avatarUrl}
                  onPress={() => {
                    open({ kind: 'player', player })
                  }}
                />
              ))}
            </>
          )}
        </ScrollView>
      )}
    </View>
  )
}
function SearchRow({
  label,
  image,
  onPress
}: {
  label: string
  image: string | null
  onPress: () => void
}): React.ReactElement {
  const [focused, setFocused] = useState(false)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      onFocus={() => {
        setFocused(true)
      }}
      onBlur={() => {
        setFocused(false)
      }}
      style={[styles.result, focused && styles.tileFocus]}
    >
      <View style={styles.identity}>
        {image !== null && (
          <Image source={{ uri: image }} style={styles.identity} />
        )}
      </View>
      <Text numberOfLines={1} style={styles.heading}>
        {label}
      </Text>
      <Text style={styles.copy}>›</Text>
    </Pressable>
  )
}
function BrowsePage({
  client,
  page,
  active,
  onOpen,
  onPlay
}: {
  client: TeamStationClient
  page: TvPage
  active: boolean
  onOpen: (page: TvPage) => void
  onPlay: (request: TvPlayRequest) => void
}): React.ReactElement {
  const { width } = useWindowDimensions()
  const tileWidth = (width - 152 - 72) / 4
  const [collection, setCollection] = useState<TvCollection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [more, setMore] = useState(false)
  const [focus, setFocus] = useState('')
  const [restoringFocus, setRestoringFocus] = useState(active)
  useEffect(() => {
    setRestoringFocus(active)
  }, [active])
  const rememberFocus = (id: string): void => {
    setFocus(id)
    setRestoringFocus(false)
  }
  const alive = useRef(true)
  const filter = useMemo(
    () =>
      page.kind === 'team'
        ? { team: page.team.id }
        : page.kind === 'player'
          ? { participant: page.player.userId }
          : {},
    [page]
  )
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    let current = true
    setError(null)
    loadTvCollection(client, filter)
      .then(result => {
        if (current) setCollection(result)
      })
      .catch(() => {
        if (current) setError('Games are unavailable. Try again.')
      })
    return () => {
      current = false
    }
  }, [client, filter, retry])
  const loadMore = async (): Promise<void> => {
    if (more || collection?.nextOffset == null) return
    setMore(true)
    setError(null)
    try {
      const games = await client.videoGames({
        ...filter,
        offset: collection.nextOffset,
        limit: 50
      })
      if (alive.current)
        setCollection({
          ...collection,
          remaining: [...collection.remaining, ...games],
          nextOffset: games.length === 50 ? collection.nextOffset + 50 : null
        })
    } catch {
      if (alive.current) setError('More games could not load. Try again.')
    } finally {
      if (alive.current) setMore(false)
    }
  }
  const gameTile = (game: VideoGame, prefix: string): React.ReactElement => (
    <Tile
      key={game.id}
      id={`${prefix}-${game.id}`}
      image={game.posterUrl}
      title={`${game.awayTeamName} at ${game.homeTeamName}`}
      detail={gameDate(game)}
      width={tileWidth}
      preferred={active && restoringFocus && focus === `${prefix}-${game.id}`}
      onFocus={rememberFocus}
      onPress={() => {
        onPlay({ game })
      }}
    />
  )
  const row = (
    title: string,
    games: VideoGame[],
    prefix: string
  ): React.ReactElement => (
    <View key={prefix} style={styles.row}>
      <Text style={styles.heading}>{title}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.horizontal}
      >
        {games.map(game => gameTile(game, prefix))}
      </ScrollView>
    </View>
  )
  const children: React.ReactElement[] = []
  const sticky: number[] = []
  if (collection !== null) {
    const hero = collection.hero
    children.push(
      <View
        key="hero"
        style={[styles.hero, page.kind !== 'home' && styles.entityHero]}
      >
        {hero?.posterUrl != null && (
          <Image
            source={{ uri: hero.posterUrl }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
          />
        )}
        <TvScrim />
        <View style={styles.heroDetails}>
          {page.kind === 'team' ? (
            <View style={styles.entityTitle}>
              {page.team.logoUrl !== null && (
                <Image
                  source={{ uri: page.team.logoUrl }}
                  style={styles.logo}
                />
              )}
              <Text numberOfLines={2} style={styles.title}>
                {page.team.name}
              </Text>
            </View>
          ) : page.kind === 'player' ? (
            <Text numberOfLines={1} ellipsizeMode="tail" style={styles.title}>
              {page.player.shortName ?? 'Player'}
            </Text>
          ) : hero !== null ? (
            <>
              <View style={styles.matchup}>
                <View style={styles.homeName}>
                  {hero.homeLogoUrl !== null && (
                    <Image
                      source={{ uri: hero.homeLogoUrl }}
                      style={styles.logo}
                    />
                  )}
                  <Text numberOfLines={2} style={styles.title}>
                    {hero.homeTeamName}
                  </Text>
                </View>
                <Text style={styles.versus}>vs.</Text>
                <View style={styles.awayName}>
                  {hero.awayLogoUrl !== null && (
                    <Image
                      source={{ uri: hero.awayLogoUrl }}
                      style={styles.logo}
                    />
                  )}
                  <Text
                    numberOfLines={2}
                    style={[styles.title, { textAlign: 'right' }]}
                  >
                    {hero.awayTeamName}
                  </Text>
                </View>
              </View>
              <Text style={styles.copy}>{gameDate(hero)}</Text>
              {hero.venue !== null && (
                <Text style={styles.copy}>{hero.venue}</Text>
              )}
              <View style={styles.watch}>
                <TvButton
                  label={hero.isLive ? '▶ Watch Live' : '▶ Watch Game'}
                  preferred={
                    active &&
                    restoringFocus &&
                    (focus === '' || focus === 'hero')
                  }
                  onFocus={() => {
                    rememberFocus('hero')
                  }}
                  onPress={() => {
                    onPlay({ game: hero })
                  }}
                />
              </View>
            </>
          ) : (
            <Text style={styles.title}>Your games</Text>
          )}
        </View>
      </View>
    )
    if (page.kind === 'team') {
      for (const [index, section] of monthSections([
        ...collection.recent,
        ...collection.remaining
      ]).entries()) {
        sticky.push(children.length)
        children.push(
          <View key={`month-${index}`} style={styles.month}>
            <TvScrim header />
            <Text style={styles.heading}>{section.month}</Text>
          </View>
        )
        section.rows.forEach((games, i) =>
          children.push(
            <View key={`grid-${index}-${i}`} style={styles.gridRow}>
              {games.map(game => gameTile(game, 'team'))}
            </View>
          )
        )
      }
    } else {
      if (collection.recent.length > 0)
        children.push(row('Recent Games', collection.recent, 'recent'))
      if (collection.highlights.length > 0)
        children.push(
          <View key="highlights" style={styles.row}>
            <Text style={styles.heading}>Recent Highlights</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.horizontal}
            >
              {collection.highlights.map(clip => (
                <Tile
                  key={`${clip.game.id}-${clip.eventId}`}
                  id={`clip-${clip.game.id}-${clip.eventId}`}
                  title={clip.title}
                  detail={gameDate(clip.game)}
                  image={clip.stillUrl}
                  width={tileWidth}
                  preferred={
                    active &&
                    restoringFocus &&
                    focus === `clip-${clip.game.id}-${clip.eventId}`
                  }
                  onFocus={rememberFocus}
                  onPress={() => {
                    onPlay({ game: clip.game, clip })
                  }}
                />
              ))}
            </ScrollView>
          </View>
        )
      collection.teamRows.forEach(({ team, games }) =>
        children.push(row(`Recent ${team.name}`, games, `follow-${team.id}`))
      )
      if (collection.teams.length > 0)
        children.push(
          <View key="teams" style={styles.row}>
            <Text style={styles.heading}>Teams</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.horizontal}
            >
              {collection.teams.map(team => (
                <Tile
                  key={team.id}
                  id={`team-${team.id}`}
                  image={team.logoUrl}
                  title={team.name}
                  width={tileWidth}
                  preferred={
                    active && restoringFocus && focus === `team-${team.id}`
                  }
                  onFocus={rememberFocus}
                  onPress={() => {
                    onOpen({ kind: 'team', team })
                  }}
                />
              ))}
            </ScrollView>
          </View>
        )
      if (collection.remaining.length > 0) {
        children.push(
          <Text key="remaining" style={[styles.heading, styles.gridHeading]}>
            More Games
          </Text>
        )
        fourAcross(collection.remaining).forEach((games, index) =>
          children.push(
            <View key={`remaining-${index}`} style={styles.gridRow}>
              {games.map(game => gameTile(game, 'more'))}
            </View>
          )
        )
      }
    }
    if (collection.recent.length === 0)
      children.push(
        <Text key="empty" style={[styles.copy, styles.gridHeading]}>
          No games are available yet.
        </Text>
      )
  }
  return (
    <ScrollView
      testID={`tv-page-${pageKey(page)}`}
      style={styles.page}
      contentContainerStyle={styles.pageContent}
      stickyHeaderIndices={sticky}
    >
      {children}
      {collection === null && error === null && (
        <Text style={[styles.copy, styles.gridHeading]}>Loading games…</Text>
      )}
      {error !== null && (
        <View style={styles.status}>
          <Text style={styles.copy}>{error}</Text>
          <TvButton
            label="Retry games"
            onPress={() => {
              if (collection === null) setRetry(n => n + 1)
              else loadMore().catch(() => undefined)
            }}
          />
        </View>
      )}
      {collection?.nextOffset != null && (
        <View style={styles.status}>
          <TvButton
            label={more ? 'Loading more…' : 'More games'}
            onPress={() => {
              loadMore().catch(() => undefined)
            }}
          />
        </View>
      )}
    </ScrollView>
  )
}
const styles = StyleSheet.create({
  scene: { flex: 1, width: '100%', backgroundColor: '#454545' },
  toolbar: {
    height: 115,
    paddingHorizontal: 76,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 24,
    backgroundColor: '#252525'
  },
  brand: { fontSize: 31, color: '#fff', fontWeight: '700' },
  welcome: { color: '#ddd', fontSize: 18, flex: 1 },
  search: {
    height: 60,
    width: 400,
    color: '#fff',
    fontSize: 24,
    backgroundColor: '#555',
    borderRadius: 30,
    paddingHorizontal: 30
  },
  page: { flex: 1 },
  hidden: { display: 'none' },
  pageContent: { paddingBottom: 90 },
  hero: { height: 550, justifyContent: 'center' },
  entityHero: { height: 400 },
  heroDetails: { paddingHorizontal: 76, width: 1050, gap: 18 },
  title: { fontSize: 48, color: '#fff', fontWeight: '700', flexShrink: 1 },
  matchup: { flexDirection: 'row', alignItems: 'center', gap: 24 },
  homeName: { flex: 1, alignItems: 'flex-start', gap: 16 },
  awayName: { flex: 1, alignItems: 'flex-end', gap: 16 },
  versus: { fontSize: 25, color: '#ddd' },
  logo: { width: 78, height: 78, resizeMode: 'contain' },
  entityTitle: { flexDirection: 'row', alignItems: 'center', gap: 24 },
  watch: { alignSelf: 'flex-start', marginTop: 10 },
  copy: { fontSize: 25, color: '#eee' },
  heading: { fontSize: 32, color: '#fff', fontWeight: '700' },
  row: { marginBottom: 38, paddingLeft: 76, gap: 18 },
  horizontal: { gap: 24, paddingRight: 76, paddingTop: 8, paddingBottom: 8 },
  tile: {
    borderWidth: 3,
    borderColor: 'transparent',
    borderRadius: 17,
    padding: 3,
    gap: 7
  },
  tileFocus: {
    borderColor: '#fff',
    backgroundColor: '#5d506d',
    transform: [{ scale: 1.025 }]
  },
  thumbnail: {
    backgroundColor: '#292e2c',
    borderRadius: 12,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center'
  },
  placeholder: { fontSize: 54, color: '#818b84' },
  tileTitle: { fontSize: 24, color: '#fff' },
  tileDetail: { fontSize: 21, color: '#eee' },
  gridRow: {
    flexDirection: 'row',
    gap: 24,
    paddingHorizontal: 76,
    marginBottom: 28
  },
  gridHeading: { paddingHorizontal: 76, marginVertical: 24 },
  month: {
    height: 92,
    paddingHorizontal: 76,
    paddingTop: 20,
    justifyContent: 'flex-start'
  },
  status: { padding: 76, gap: 24, alignItems: 'flex-start' },
  searchResults: {
    position: 'absolute',
    top: 115,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#292929'
  },
  searchContent: { padding: 76, gap: 20 },
  result: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 24,
    borderWidth: 3,
    borderColor: 'transparent',
    borderRadius: 18,
    backgroundColor: '#444',
    padding: 20
  },
  identity: { height: 70, width: 70, borderRadius: 12, resizeMode: 'contain' }
})
