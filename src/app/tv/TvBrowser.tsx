import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as ReactNative from 'react-native'
import {
  Circle,
  Defs,
  Line,
  LinearGradient,
  Rect,
  Stop,
  Svg
} from 'react-native-svg'

import type {
  TeamStationClient,
  TeamSummary,
  UserMatch,
  VideoGame
} from '../../common/api'
import {
  browseGeometry,
  collectionTop,
  fourAcross,
  gameDate,
  monthSections
} from './browseLayout'
import { loadTvCollection, type TvClip, type TvCollection } from './collections'
import { HeroPreview } from './HeroPreview'
import {
  NativeGradient,
  NativeSearch,
  nativeTvPresentation,
  TvPoster,
  type TvSearchItem
} from './NativePresentation'
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

export function TvScrim(): React.ReactElement {
  if (NativeGradient !== null)
    return (
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <NativeGradient
          direction="left"
          maxOpacity={0.35}
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: '75%'
          }}
        />
        <NativeGradient
          direction="bottom"
          maxOpacity={0.15}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: '35%'
          }}
        />
      </View>
    )
  return (
    <Svg
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      width="100%"
      height="100%"
    >
      <Defs>
        <LinearGradient id="left" x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor="#000" stopOpacity={0.35} />
          <Stop offset="0.4" stopColor="#000" stopOpacity={0.18} />
          <Stop offset="0.75" stopColor="#000" stopOpacity={0} />
        </LinearGradient>
        <LinearGradient id="bottom" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0.3" stopColor="#000" stopOpacity={0} />
          <Stop offset="1" stopColor="#000" stopOpacity={0.15} />
        </LinearGradient>
      </Defs>
      <Rect width="100%" height="100%" fill="url(#left)" />
      <Rect width="100%" height="100%" fill="url(#bottom)" />
    </Svg>
  )
}

function CollectionBackground({
  top,
  rowHeight
}: {
  top: number
  rowHeight: number
}): React.ReactElement {
  return (
    <View
      testID="tv-collection-background"
      pointerEvents="none"
      style={{ position: 'absolute', top, left: 0, right: 0, bottom: 0 }}
    >
      {NativeGradient !== null ? (
        <NativeGradient
          direction="bottom"
          maxOpacity={0.1}
          style={{ height: rowHeight }}
        />
      ) : (
        <Svg width="100%" height={rowHeight}>
          <Defs>
            <LinearGradient id="collection" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="black" stopOpacity={0} />
              <Stop offset="1" stopColor="black" stopOpacity={0.1} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#collection)" />
        </Svg>
      )}
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.1)' }} />
    </View>
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
  onFocus,
  preview,
  onPreviewFocus
}: {
  id: string
  image: string | null
  title: string
  detail?: string
  width: number
  preferred: boolean
  onPress: () => void
  onFocus: (id: string) => void
  preview?: {
    client: TeamStationClient
    gameId: string
    active: boolean
    videoId?: string
  }
  onPreviewFocus?: (id: string, focused: boolean) => void
}): React.ReactElement {
  const [focused, setFocused] = useState(false)
  const [previewPosition, setPreviewPosition] = useState<number | null>(null)
  return (
    <Pressable
      testID={id}
      accessibilityRole="button"
      accessibilityValue={
        focused && previewPosition !== null
          ? { text: `Preview: ${previewPosition} seconds` }
          : undefined
      }
      accessibilityLabel={`${title}${detail === undefined ? '' : `, ${detail}`}${focused && previewPosition !== null ? `, Preview: ${previewPosition} seconds` : ''}`}
      {...{
        hasTVPreferredFocus: preferred,
        // UIImageView owns lift, parallax and Reduce Motion without a second scale.
        tvParallaxProperties: { enabled: false }
      }}
      onFocus={() => {
        setFocused(true)
        onFocus(id)
        onPreviewFocus?.(id, true)
      }}
      onBlur={() => {
        setFocused(false)
        setPreviewPosition(null)
        onPreviewFocus?.(id, false)
      }}
      onPress={onPress}
      style={[styles.tile, { width }]}
    >
      <View style={[styles.thumbnail, { height: (width * 9) / 16 }]}>
        {image === null ? (
          <View style={StyleSheet.absoluteFill}>
            <Text style={styles.placeholder}>▶</Text>
            {preview !== undefined && focused && preview.active && (
              <HeroPreview {...preview} muted onPosition={setPreviewPosition} />
            )}
          </View>
        ) : (
          <TvPoster uri={image} focused={focused}>
            {preview !== undefined && focused && preview.active && (
              <HeroPreview {...preview} muted onPosition={setPreviewPosition} />
            )}
          </TvPoster>
        )}
        {/* A static image-area cue remains visible without artwork or motion. */}
        {focused && (
          <View
            testID={`${id}-focus-cue`}
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, styles.thumbnailFocus]}
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
  const [searchOpen, setSearchOpen] = useState(false)
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
    setSearchOpen(false)
    setPages(current => [...current, page])
  }
  const back = useCallback((): void => {
    if (searchOpen || query !== '') {
      setSearchOpen(false)
      setQuery('')
    } else
      setPages(current => (current.length > 1 ? current.slice(0, -1) : current))
  }, [query, searchOpen])
  useEffect(() => {
    if (editing || searchOpen) {
      tvControl?.disableTVMenuKey()
      return
    }
    if (!visible || (query === '' && pages.length === 1)) return
    tvControl?.enableTVMenuKey()
    return () => tvControl?.disableTVMenuKey()
  }, [visible, query, pages.length, editing, searchOpen])
  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        if (
          visible &&
          !editing &&
          (searchOpen || query !== '' || pages.length > 1)
        ) {
          back()
          return true
        }
        return false
      }
    )
    return () => {
      subscription.remove()
    }
  }, [back, query, pages.length, visible, editing, searchOpen])
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
  const searchItems: TvSearchItem[] =
    results === null
      ? []
      : [
          ...results.teams.map(team => ({
            id: `team:${team.id}`,
            title: team.name,
            image: team.logoUrl,
            detail: [team.videoSeason?.name, team.videoSeason?.leagueName]
              .filter(Boolean)
              .join(' · ')
          })),
          ...results.players.map(player => ({
            id: `player:${player.userId}`,
            title: player.shortName ?? 'Player',
            image: player.avatarUrl,
            detail: (player.recentVideoTeams ?? [])
              .map(team => team.name)
              .join(' · ')
          }))
        ]
  const selectResult = (id: string): void => {
    if (id === 'retry') {
      setRetry(n => n + 1)
      return
    }
    const team = results?.teams.find(team => `team:${team.id}` === id)
    const player = results?.players.find(
      player => `player:${player.userId}` === id
    )
    if (team !== undefined) open({ kind: 'team', team })
    else if (player !== undefined) open({ kind: 'player', player })
  }
  const searchStatus =
    searchError ??
    (query.trim() === ''
      ? 'Search teams or players'
      : results === null
        ? 'Searching…'
        : searchItems.length === 0
          ? 'No accessible teams or players found.'
          : '')
  return (
    <View style={styles.scene}>
      <FocusGuide key={active} autoFocus style={styles.toolbar}>
        <Text style={styles.brand}>TeamStation TV</Text>
        <Text style={styles.welcome}>Welcome, {viewerName}</Text>
        {nativeTvPresentation ? (
          <Pressable
            testID="tv-search"
            accessibilityRole="button"
            accessibilityLabel="Search teams or players"
            onPress={() => {
              setSearchOpen(true)
            }}
            style={styles.search}
          >
            <View testID="tv-search-label" style={styles.searchLabel}>
              <Svg width={28} height={28} viewBox="0 0 28 28">
                <Circle
                  cx={11}
                  cy={11}
                  r={8}
                  fill="none"
                  stroke="white"
                  strokeWidth={2.5}
                />
                <Line
                  x1={17}
                  y1={17}
                  x2={25}
                  y2={25}
                  stroke="white"
                  strokeWidth={2.5}
                />
              </Svg>
              <Text style={styles.searchText}>Search</Text>
            </View>
          </Pressable>
        ) : (
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
        )}
        <TvButton label="Sign out" onPress={onSignOut} />
      </FocusGuide>
      {searchOpen && visible && NativeSearch !== null && (
        <NativeSearch
          style={StyleSheet.absoluteFill}
          items={
            searchError === null
              ? searchItems
              : [
                  {
                    id: 'retry',
                    title: 'Retry search',
                    detail: '',
                    image: null
                  }
                ]
          }
          status={searchStatus}
          onQuery={event => {
            setQuery(event.nativeEvent.query)
          }}
          onSelect={event => {
            selectResult(event.nativeEvent.id)
          }}
          onDismiss={() => {
            setSearchOpen(false)
            setQuery('')
          }}
        />
      )}
      {pages.map((page, index) => (
        <View
          key={`${index}-${pageKey(page)}`}
          style={[
            styles.page,
            (index !== active || query.trim() !== '' || searchOpen) &&
              styles.hidden
          ]}
        >
          <BrowsePage
            client={client}
            page={page}
            active={visible && index === active && query === '' && !searchOpen}
            onOpen={open}
            onPlay={onPlay}
          />
        </View>
      ))}
      {!nativeTvPresentation && query.trim() !== '' && (
        <ScrollView
          testID="tv-search-results"
          style={styles.searchResults}
          contentContainerStyle={styles.searchContent}
        >
          {searchStatus !== '' && (
            <Text style={styles.copy}>{searchStatus}</Text>
          )}
          {searchError !== null && (
            <TvButton
              label="Retry search"
              onPress={() => {
                setRetry(n => n + 1)
              }}
            />
          )}
          <View style={styles.searchGrid}>
            {searchItems.map(item => (
              <SearchRow
                key={item.id}
                label={item.title}
                detail={item.detail}
                image={item.image}
                onPress={() => {
                  selectResult(item.id)
                }}
              />
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  )
}
function SearchRow({
  label,
  detail,
  image,
  onPress
}: {
  label: string
  detail: string
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
      <View style={{ flex: 1 }}>
        <Text numberOfLines={2} style={styles.heading}>
          {label}
        </Text>
        {detail !== '' && (
          <Text numberOfLines={2} style={styles.copy}>
            {detail}
          </Text>
        )}
      </View>
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
  const { width, height, fontScale } = useWindowDimensions()
  const [viewportHeight, setViewportHeight] = useState(height - 115)
  const [scrollY, setScrollY] = useState(0)
  const geometry = browseGeometry(
    width,
    viewportHeight,
    page.kind === 'team',
    fontScale
  )
  const tileWidth = geometry.tileWidth
  const [collection, setCollection] = useState<TvCollection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [heroVisible, setHeroVisible] = useState(true)
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
  const [previewFocus, setPreviewFocus] = useState<string | null>(null)
  const previewFocusChanged = useCallback(
    (id: string, focused: boolean): void => {
      setPreviewFocus(current =>
        focused ? id : current === id ? null : current
      )
    },
    []
  )
  const gameTile = (game: VideoGame, prefix: string): React.ReactElement => (
    <Tile
      key={game.id}
      preview={{ client, gameId: game.id, active }}
      onPreviewFocus={previewFocusChanged}
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
      <Text style={[styles.heading, styles.rowHeading]}>{title}</Text>
      <ScrollView
        horizontal
        style={styles.horizontalViewport}
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
        testID="tv-hero"
        style={[styles.hero, { height: geometry.heroHeight }]}
      >
        {hero?.posterUrl != null && (
          <Image
            source={{ uri: hero.posterUrl }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
          />
        )}
        {hero !== null && (
          <HeroPreview
            client={client}
            gameId={hero.id}
            active={active && heroVisible && previewFocus === null}
          />
        )}
        <TvScrim />
        <View
          style={[
            styles.heroDetails,
            {
              transformOrigin: 'left center',
              transform: [
                { scale: Math.min(1, geometry.heroHeight / (440 * fontScale)) }
              ]
            }
          ]}
        >
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
          <View
            key={`month-${index}`}
            testID={`tv-month-${index}`}
            style={styles.month}
          >
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
            <Text style={[styles.heading, styles.rowHeading]}>
              Recent Highlights
            </Text>
            <ScrollView
              horizontal
              style={styles.horizontalViewport}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.horizontal}
            >
              {collection.highlights.map(clip => (
                <Tile
                  key={`${clip.game.id}-${clip.eventId}`}
                  preview={{
                    client,
                    gameId: clip.game.id,
                    videoId: clip.videoId,
                    active
                  }}
                  onPreviewFocus={previewFocusChanged}
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
            <Text style={[styles.heading, styles.rowHeading]}>Teams</Text>
            <ScrollView
              horizontal
              style={styles.horizontalViewport}
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
    <View
      style={styles.page}
      onLayout={event => {
        setViewportHeight(event.nativeEvent.layout.height)
      }}
    >
      <CollectionBackground
        top={collectionTop(geometry.heroHeight, scrollY)}
        rowHeight={geometry.rowHeight}
      />
      <ScrollView
        testID={`tv-page-${pageKey(page)}`}
        style={styles.page}
        contentContainerStyle={styles.pageContent}
        onScroll={event => {
          const y = event.nativeEvent.contentOffset.y
          setScrollY(y)
          setHeroVisible(y < geometry.heroHeight)
        }}
        scrollEventThrottle={16}
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
    </View>
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
    backgroundColor: '#454545'
  },
  brand: { fontSize: 31, color: '#fff', fontWeight: '700' },
  welcome: { color: '#ddd', fontSize: 18, flex: 1 },
  search: {
    height: 60,
    width: 210,
    alignItems: 'center',
    justifyContent: 'center',
    color: '#fff',
    fontSize: 24,
    backgroundColor: '#555',
    borderRadius: 30,
    paddingHorizontal: 30
  },
  searchLabel: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'center',
    justifyContent: 'center'
  },
  searchText: {
    fontSize: 25,
    lineHeight: 30,
    color: '#fff',
    includeFontPadding: false
  },
  page: { flex: 1 },
  hidden: { display: 'none' },
  pageContent: { paddingBottom: 90 },
  hero: { justifyContent: 'center' },
  heroDetails: { paddingHorizontal: 76, width: 1050, gap: 18 },
  title: { fontSize: 70, color: '#fff', fontWeight: '700', flexShrink: 1 },
  matchup: { flexDirection: 'row', alignItems: 'center', gap: 24 },
  homeName: { flex: 1, alignItems: 'flex-start', gap: 16 },
  awayName: { flex: 1, alignItems: 'flex-end', gap: 16 },
  versus: { fontSize: 25, color: '#ddd' },
  logo: { width: 78, height: 78, resizeMode: 'contain' },
  entityTitle: { flexDirection: 'row', alignItems: 'center', gap: 24 },
  watch: { alignSelf: 'flex-start', marginTop: 10 },
  copy: { fontSize: 25, color: '#eee' },
  heading: { fontSize: 32, lineHeight: 38, color: '#fff', fontWeight: '700' },
  rowHeading: { marginLeft: 76 },
  row: { marginBottom: 38, gap: 18 },
  horizontalViewport: { marginHorizontal: 52 },
  horizontal: { gap: 24, padding: 24 },
  tile: {
    borderRadius: 17,
    gap: 7
  },
  tileFocus: {
    borderColor: '#fff',
    backgroundColor: '#5d506d',
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 }
  },
  thumbnail: {
    backgroundColor: '#292e2c',
    borderRadius: 12,
    overflow: 'visible',
    alignItems: 'center',
    justifyContent: 'center'
  },
  thumbnailFocus: {
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderRadius: 12
  },
  placeholder: { fontSize: 54, color: '#818b84' },
  tileTitle: { fontSize: 32, lineHeight: 38, color: '#fff' },
  tileDetail: { fontSize: 28, lineHeight: 34, color: '#eee' },
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
  searchGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 24 },
  result: {
    width: '31.8%',
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
