import React, { memo, useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Text,
  useWindowDimensions,
  View
} from 'react-native'

import type {
  BattingRow,
  GamesPageQuery,
  GameSummary,
  Page,
  PitchingRow,
  RosterEntry,
  StaffEntry,
  StandingsRow,
  TeamStationClient,
  TeamSummary
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { eventName, type PlayerRsvpCounts } from '../../common/eventInfo'
import type { GroupDetail } from '../../common/publicGroups'
import type { Role } from '../../common/roles'
import { type ChatLink, ChatLinks } from '../chat/ChatLinks'
import {
  Badge,
  Card,
  CardBand,
  GameRow,
  HandoffView,
  ManageGear,
  PillBand,
  PillTabs,
  PinnedContent,
  PinnedSpacer,
  RsvpScheduleRow,
  ScheduleRow,
  Screen,
  SectionHeader,
  SettingsGear,
  type Stat,
  StatGrid,
  TeamEmblem,
  useBreakpoint,
  useHeaderHandoff,
  usePaneWidth,
  usePinnedHandoff,
  usePinnedTabs
} from '../components'
import { AddEventCard } from '../components/AddEventCard'
import { FollowButton } from '../components/FollowButton'
import { PagedList } from '../components/PagedList'
import { PagedListEnd } from '../components/PagedListEnd'
import {
  inheritedPill,
  PeopleList,
  peopleSubtitle
} from '../components/PeopleList'
import type { PinnedHead } from '../components/pinnedHead'
import { flagLabel } from '../components/roleLabels'
import { StatisticsTable } from '../components/StatisticsTable'
import { ActiveView, TabPages } from '../components/TabPages'
import { type PagedRows, usePagedList } from '../hooks/usePagedList'
import { useStableCallback } from '../hooks/useStableCallback'
import { videoCountLabel } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import {
  clock,
  matchupLines,
  resultFor,
  shortDate,
  shortDateNoWeekday,
  shortTime
} from './format'
import { type GameListOpenOptions, gameListOptions } from './gameListOptions'
import { MembershipAccess } from './MembershipAccess'
import { PublicTeamContent } from './PublicTeamContent'
import { hasScheduleRsvpLine, ScheduleRsvpControl } from './ScheduleRsvpControl'
import { battingColumns, pitchingColumns } from './statColumns'

/** The first read of each list, which the screen makes as it opens. */
const SCHEDULE_OPENS: GamesPageQuery = { around: 'next', order: 'asc' }
const VIDEOS_OPEN: GamesPageQuery = { hasVideo: true }

const NO_GAMES: Page<GameSummary> = {
  items: [],
  nextCursor: null,
  prevCursor: null,
  anchorId: null,
  counts: null
}

/** A row's height before it has been measured, as each list draws them. */
const ROW_HEIGHT = { schedule: 150, videos: 130 }

const gameId = (game: GameSummary): string => game.id

export interface TeamScreenProps {
  client: TeamStationClient
  signedIn?: boolean
  onSignIn?: () => void
  team: TeamSummary
  /**
   * The public projection, for somebody not signed in: nobody signed in
   * reads anything else of a team.
   */
  publicDetail?: GroupDetail
  /**
   * Somebody signed in who is not a member, following the team or not: the
   * members' page less what is kept for members. No batting or pitching and no player pages, which answer them `404`.
   * The video library opens the game with playback unavailable.
   */
  nonMemberView?: boolean
  /** Revalidate private collections when the access adapter refreshes. */
  refreshRevision?: number
  /** The gear in the card's corner, for somebody who administers this team. */
  onManage?: () => void
  onCreateGame?: () => void
  onOpenGame: (
    gameId: string,
    title: string,
    options?: GameListOpenOptions
  ) => void
  /**
   * A name on the roster. The team travels with it as `onTeam`, the team the
   * page was opened for: the player's videos and stats open narrowed to it
   * rather than to a career total nobody asked for, and a coach's Settings
   * tab edits the player on it.
   */
  onOpenPlayer?: (
    userId: string,
    name: string,
    from?: { seasonId?: string; teamId?: string; onTeam?: string }
  ) => void
  /**
   * Somebody on the roster who is not a player, opened as their person
   * profile from this team (its canonical id): offered only with
   * `managesPeople`.
   */
  onOpenPerson?: (userId: string, name: string, teamId: string) => void
  /**
   * The viewer administers, coaches or assists this team: every row of the
   * roster opens, a player's page or anybody else's profile.
   */
  managesPeople?: boolean
  /** Which section to open on, from the address. */
  initialTab?: string
  /**
   * Tells the shell which section is showing, so the address can say so.
   *
   * `correcting` is set when the screen is answering a `?tab=` it could not
   * honour: the address said one thing and the screen is showing another, so
   * the entry is corrected rather than a new one added.
   */
  onTab?: (tab: string, correcting?: boolean) => void
  /** This team's chats the person is in, each opening from the page. */
  chats?: ChatLink[]
  onOpenChat?: (chat: ChatLink) => void
  onLoadChatPreview?: (ids: string[]) => void
}

type TabId = 'videos' | 'schedule' | 'team' | 'stats' | 'chats'

/**
 * The section a `?tab=` names, or the one this screen opens on.
 *
 * `roster` is taken as `team` because that is what the pill said when the
 * address was first written down, and a link somebody sent should not stop
 * working because the word on the button changed.
 */
function tabOf(id: string | undefined): TabId {
  if (id === 'roster') return 'team'
  return TABS.some(item => item.id === id) ? (id as TabId) : 'videos'
}

const TABS = [
  { id: 'videos' as const, label: 'Videos' },
  { id: 'schedule' as const, label: 'Schedule' },
  { id: 'team' as const, label: 'Team' },
  { id: 'stats' as const, label: 'Stats' },
  { id: 'chats' as const, label: 'Chats' }
]

/**
 * A team: what was recorded, when they play, who is on it, and how they did.
 *
 * The four tabs are the design's, and they are the reason `PillTabs` exists —
 * the same strip appears on the league hub and the game screen, and drawing it
 * three ways was the single most visible inconsistency in the set.
 *
 * Everything loads on first open, in one pass rather than per tab. Four small
 * requests against a season's worth of rows is quicker than the spinner a
 * parent would otherwise meet on every tap, and it means switching tabs is
 * instant, which is what makes a tab strip feel like one screen.
 */
export function TeamScreen(props: TeamScreenProps): React.ReactElement {
  const {
    client,
    team,
    onOpenGame,
    onOpenPlayer,
    onOpenPerson,
    managesPeople = false,
    initialTab,
    onTab,
    onManage,
    onCreateGame,
    publicDetail,
    nonMemberView = false,
    refreshRevision
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const membershipAccess = (
    <MembershipAccess
      key={`${team.id}:${props.signedIn === true}`}
      client={client}
      signedIn={props.signedIn === true}
      teams={[{ id: team.id, name: team.name }]}
      onSignIn={() => props.onSignIn?.()}
    />
  )
  const { fontScale } = useWindowDimensions()
  const width = usePaneWidth()
  const [identityWidth, setIdentityWidth] = useState<number>()

  // The team's name slides up into the header as its card goes under, and
  // comes back down when it returns. The header carries no title for this
  // screen otherwise: the name is on the card a few pixels below it.
  const head = usePinnedHandoff()
  const { handoff } = head
  const progress = handoff.progress
  useHeaderHandoff(
    useMemo(
      () => (
        <HandoffView progress={progress} style={styles.headerHandoff}>
          {/*
            The mark comes up with the name. There is a gap between the chevron
            and the name the width of one, and a team is easier to recognise by
            its badge than by the first twenty characters of its name.
          */}
          <TeamEmblem uri={team.logoUrl} name={team.name} size={1.75} />
          <Text style={styles.headerName} numberOfLines={1}>
            {team.name}
          </Text>
        </HandoffView>
      ),
      [
        progress,
        styles.headerHandoff,
        styles.headerName,
        team.logoUrl,
        team.name
      ]
    )
  )

  const [tab, setTab] = useState<TabId>(tabOf(initialTab))
  const schedule = usePagedList<GameSummary>({
    listKey: `${team.id}:schedule`,
    auto: false,
    keyOf: gameId,
    read: async cursor =>
      await client.teamGamesPage(
        team.id,
        cursor == null ? SCHEDULE_OPENS : { cursor }
      )
  })
  const videos = usePagedList<GameSummary>({
    listKey: `${team.id}:videos`,
    auto: false,
    keyOf: gameId,
    read: async cursor =>
      await client.teamGamesPage(
        team.id,
        cursor == null ? VIDEOS_OPEN : { ...VIDEOS_OPEN, cursor }
      )
  })
  const { apply: applySchedule } = schedule
  const { apply: applyVideos } = videos
  const [roster, setRoster] = useState<RosterEntry[]>([])
  const [batting, setBatting] = useState<BattingRow[]>([])
  const [pitching, setPitching] = useState<PitchingRow[]>([])
  const [standing, setStanding] = useState<StandingsRow | undefined>(undefined)
  /** Where this team sits in its season, 1 for first. */
  const [place, setPlace] = useState<number | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)

  // Browser/native Back can change the address while this team stays mounted.
  useEffect(() => {
    const next = tabOf(initialTab)
    setTab(next)
    if (initialTab != null && initialTab !== next) onTab?.(next, true)
    // React to the address, not the shell's freshly created callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab])

  useEffect(() => {
    let cancelled = false
    if (publicDetail != null) {
      setLoading(false)
      return
    }
    setError(undefined)
    const load = async (): Promise<void> => {
      const [firstGames, firstVideos] = await Promise.all([
        client.teamGamesPage(team.id, SCHEDULE_OPENS),
        client.teamGamesPage(team.id, VIDEOS_OPEN)
      ])
      if (cancelled) return
      await Promise.all([applySchedule(firstGames), applyVideos(firstVideos)])
      if (cancelled) return

      const seasonId = firstGames.counts?.newestSeasonId
      // A non-member is refused the figures, so they are not asked for.
      const noRows = Promise.resolve([])
      const [loadedRoster, loadedBatting, loadedPitching, standings] =
        await Promise.all([
          client.roster(team.id),
          nonMemberView
            ? noRows
            : client.teamStats(team.id, seasonId ?? undefined),
          nonMemberView
            ? noRows
            : client.teamPitchingStats(team.id, seasonId ?? undefined),
          seasonId == null
            ? Promise.resolve<StandingsRow[]>([])
            : client.standings(seasonId).catch((error: unknown) => {
                // A team's own roster and stats do not require access to an
                // unrelated host season or a season with no enrolled teams.
                if (
                  error instanceof HttpError &&
                  ['forbidden', 'notFound'].includes(error.code)
                )
                  return []
                throw error
              })
        ])
      if (cancelled) return
      setRoster(loadedRoster)
      setBatting(loadedBatting)
      setPitching(loadedPitching)
      setStanding(standings.find(row => row.teamId === team.id))
      // The position is the row's place in the standings the server already
      // sorted. Working it out again here is how two screens come to disagree
      // about who is top.
      const at = standings.findIndex(row => row.teamId === team.id)
      setPlace(at < 0 ? undefined : at + 1)
    }
    load()
      .catch((caught: unknown) => {
        if (!cancelled) {
          if (
            caught instanceof HttpError &&
            ['forbidden', 'notFound'].includes(caught.code)
          ) {
            applySchedule(NO_GAMES).catch(() => undefined)
            applyVideos(NO_GAMES).catch(() => undefined)
            setRoster([])
            setBatting([])
            setPitching([])
            setStanding(undefined)
            setPlace(undefined)
          }
          setError(caught instanceof Error ? caught.message : 'Cannot load')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [
    applySchedule,
    applyVideos,
    client,
    team.id,
    publicDetail,
    nonMemberView,
    refreshRevision
  ])

  const follows = onManage == null && (publicDetail != null || nonMemberView)
  // A name needs room of its own when both corner controls are present.
  // Measure the card, since its reading-width cap can differ from the window.
  const nameBelowControls =
    place != null &&
    onManage != null &&
    (identityWidth ?? width) < theme.rem(24) * fontScale
  const identityWords = (
    <View style={styles.identityText} testID="team-hero-words">
      <Text style={styles.teamName}>{team.name}</Text>
      {standing != null && (
        <Text style={styles.teamMeta}>
          {standing.w}–{standing.l}
          {standing.t > 0 ? `–${standing.t}` : ''} · {standing.played} played
        </Text>
      )}
    </View>
  )
  // The whole list's, whichever of its rows are loaded.
  const counts = schedule.counts ?? videos.counts

  // The card scrolls away and the pills pin under the header; a selected tab
  // starts directly under them, the schedule at its next game.
  const { pinned, selectTab } = usePinnedTabs({
    head,
    ready: !loading,
    tab,
    anchorOnRow: tab === 'schedule' && schedule.anchorId != null
  })

  // Which way a pill change slides the content.
  const tabIndex = TABS.findIndex(item => item.id === tab)
  // The latest handler under one identity: a season's cards, kept built
  // across pill changes, are drawn again only when their games change.
  const openGame = useStableCallback(onOpenGame)

  // As on the roster: a non-member is answered `404` on a player's page.
  const openStatsPlayer =
    nonMemberView || onOpenPlayer == null
      ? undefined
      : (row: { userId: string; shortName?: string }): void => {
          onOpenPlayer(row.userId, row.shortName ?? 'Unknown', {
            teamId: team.id
          })
        }

  return (
    <Screen {...pinned.screen} pagedList>
      <CardBand part={pinned.cardBand}>
        <Card style={styles.identity}>
          <View
            style={[
              styles.identityTop,
              nameBelowControls && styles.identityTopCompact
            ]}
            onLayout={event => {
              setIdentityWidth(event.nativeEvent.layout.width)
            }}
          >
            <TeamEmblem uri={team.logoUrl} name={team.name} size={3.5} />
            {nameBelowControls ? (
              <View style={styles.identitySpace} />
            ) : (
              identityWords
            )}
            {place != null && onManage != null && (
              <Badge label={placeLabel(place)} tone="honour" />
            )}
            {(place != null || follows || onManage != null) && (
              <View
                testID="team-card-end"
                style={[
                  styles.identityEnd,
                  place == null && onManage == null && styles.identityEndLevel
                ]}
              >
                {place != null && onManage == null && (
                  <Badge label={placeLabel(place)} tone="honour" />
                )}
                {follows && (
                  <FollowButton
                    client={client}
                    group={{ kind: 'team', id: team.id }}
                    name={team.name}
                  />
                )}
                {onManage != null && (
                  <View testID="team-card-gear" style={styles.gear}>
                    {publicDetail == null ? (
                      <ManageGear
                        client={client}
                        scopeType="team"
                        scopeId={team.id}
                        onPress={onManage}
                      />
                    ) : (
                      <SettingsGear label="Team settings" onPress={onManage} />
                    )}
                  </View>
                )}
              </View>
            )}
          </View>
          {nameBelowControls && identityWords}
        </Card>
      </CardBand>

      <PillBand part={pinned.pillBand}>
        <PillTabs
          tabs={TABS}
          selected={tab}
          onSelect={selected => {
            selectTab(selected)
            setTab(selected)
            onTab?.(selected)
          }}
          size="compact"
          accessibilityLabel="Team sections"
        />
      </PillBand>

      {error != null && <Text style={styles.error}>{error}</Text>}
      {loading && <Text style={styles.muted}>Loading…</Text>}

      {/* Kept built: a team's schedule runs the length of its season. */}
      {publicDetail != null && (
        <TabPages keep page={tab} index={tabIndex}>
          {tab === 'chats' ? (
            <ChatLinks
              key={tab}
              chats={props.chats ?? []}
              onOpen={props.onOpenChat}
              onLoadPreview={props.onLoadChatPreview}
            />
          ) : (
            <PublicTeamContent
              key={tab}
              membershipAccess={membershipAccess}
              detail={publicDetail}
              tab={tab}
              onOpenGame={openGame}
            />
          )}
        </TabPages>
      )}

      {(!loading || tab === 'chats') && publicDetail == null && (
        <TabPages keep page={tab} index={tabIndex}>
          <PinnedContent
            key={tab}
            part={pinned.content}
            testID="teamTabContent"
          >
            {tab === 'chats' && (
              <ChatLinks
                chats={props.chats ?? []}
                onOpen={props.onOpenChat}
                onLoadPreview={props.onLoadChatPreview}
              />
            )}
            {tab === 'videos' && (
              <View style={styles.section}>
                <SectionHeader
                  title="Game video library"
                  note={`${counts?.withVideo ?? 0} with video`}
                />
                <VideoRows
                  list={videos}
                  teamId={team.id}
                  nonMemberView={nonMemberView}
                  onOpen={openGame}
                />
              </View>
            )}

            {tab === 'schedule' && (
              // The pinned head's own: let go while the page is kept.
              <ActiveView
                style={styles.section}
                ref={pinned.rowSection.ref}
                onLayout={pinned.rowSection.handleLayout}
              >
                <SectionHeader
                  title="Schedule"
                  note={`${counts?.total ?? 0} games, ${counts?.upcoming ?? 0} to play`}
                />
                <ScheduleRows
                  client={client}
                  list={schedule}
                  teamId={team.id}
                  nonMemberView={nonMemberView}
                  nextRow={pinned.nextRow}
                  onOpen={openGame}
                  onCreateGame={onCreateGame}
                />
              </ActiveView>
            )}

            {tab === 'team' && (
              <>
                {roster.length === 0 && (
                  <Empty text="Nobody has been added to this team yet." />
                )}
                <PeopleList
                  people={roster}
                  onOpen={person => {
                    // A player has a page, for anybody who may see it: a
                    // non-member is answered `404` there, so their rows open
                    // nothing. Anybody else opens their profile, for the
                    // team's administrators, coaches and assistants.
                    if (
                      person.isPlayer &&
                      !nonMemberView &&
                      onOpenPlayer != null
                    )
                      return () => {
                        onOpenPlayer(person.userId, person.shortName, {
                          onTeam: team.id
                        })
                      }
                    if (!nonMemberView && managesPeople && onOpenPerson != null)
                      return () => {
                        onOpenPerson(person.userId, person.shortName, team.id)
                      }
                    return undefined
                  }}
                />
              </>
            )}

            {tab === 'stats' && (
              <View style={styles.section}>
                <SectionHeader title="Season performance" />
                <Card>
                  <StatGrid stats={seasonStats(standing)} columns={2} />
                </Card>

                {/*
                A non-member sees how the team is doing, and not how each player
                is: the batting and pitching are kept for members.
              */}
                {nonMemberView ? (
                  membershipAccess
                ) : (
                  <>
                    <SectionHeader
                      title="Batting"
                      note={`${batting.length} players`}
                    />
                    {batting.length === 0 ? (
                      <Empty text="No plays have been ingested for this team yet." />
                    ) : (
                      <Card flush>
                        <StatisticsTable
                          rows={batting}
                          columns={battingColumns}
                          onOpen={openStatsPlayer}
                        />
                      </Card>
                    )}
                    {pitching.length > 0 && (
                      <>
                        <SectionHeader
                          title="Pitching"
                          note={`${pitching.length} players`}
                        />
                        <Card flush>
                          <StatisticsTable
                            rows={pitching}
                            columns={pitchingColumns}
                            onOpen={openStatsPlayer}
                          />
                        </Card>
                      </>
                    )}
                  </>
                )}
              </View>
            )}
          </PinnedContent>
        </TabPages>
      )}
      <PinnedSpacer part={pinned.spacer} />
    </Screen>
  )
}

/** The row a list opens on, and a screen of those after it. */
export function rowsKeptDrawn(
  rows: readonly GameSummary[],
  anchorId: string | null,
  screenHeight: number
): string[] | undefined {
  const at = rows.findIndex(game => game.id === anchorId)
  if (at < 0) return undefined
  const screen = Math.ceil(screenHeight / ROW_HEIGHT.schedule)
  return rows.slice(at, at + 1 + screen).map(gameId)
}

/**
 * The schedule in the order it is played, opened on its next game. That row
 * and the screen after it stay drawn, so the page lands on rows of their real
 * height, and older rows load as the reader goes up past the first.
 */
export function ScheduleRows(props: {
  client: TeamStationClient
  list: PagedRows<GameSummary>
  teamId: string
  nonMemberView: boolean
  nextRow: PinnedHead['nextRow']
  onOpen: TeamScreenProps['onOpenGame']
  onCreateGame?: () => void
}): React.ReactElement {
  const { client, list, teamId, nonMemberView, nextRow, onOpen } = props
  const { rows, anchorId, loading, empty, loadMore, loadOlder, update } = list
  const { onCreateGame } = props
  const styles = getStyles(useTheme())
  const { height } = useWindowDimensions()
  const alwaysRenderKeys = useMemo(
    () => rowsKeptDrawn(rows, anchorId, height),
    [anchorId, height, rows]
  )
  const answered = useCallback(
    (id: string, counts: PlayerRsvpCounts): void => {
      update(id, game => ({ ...game, playerRsvps: counts }))
    },
    [update]
  )
  const { ref: nextRowRef } = nextRow
  const renderRow = useCallback(
    (game: GameSummary) => (
      <ActiveView
        testID="scheduleGame"
        ref={game.id === anchorId ? nextRowRef : undefined}
        style={styles.row}
      >
        {nonMemberView ? (
          // Visitors can open every published game without receiving
          // member-only RSVP controls.
          <GameCard
            game={game}
            mode="schedule"
            teamId={teamId}
            nonMemberView
            onOpen={onOpen}
          />
        ) : (
          <ScheduleCard
            client={client}
            game={game}
            teamId={teamId}
            onOpen={onOpen}
            onAnswered={answered}
          />
        )}
      </ActiveView>
    ),
    [
      anchorId,
      answered,
      client,
      nextRowRef,
      nonMemberView,
      onOpen,
      styles.row,
      teamId
    ]
  )
  const extraData = useMemo(
    () => ({ anchorId, nonMemberView }),
    [anchorId, nonMemberView]
  )
  const anchorMoved = useStableCallback((y: number): void => {
    const event = { nativeEvent: { layout: { x: 0, y, width: 0, height: 0 } } }
    nextRow.handleLayout?.(event as unknown as LayoutChangeEvent)
  })
  return (
    <PagedList
      data={rows}
      keyOf={gameId}
      renderItem={renderRow}
      extraData={extraData}
      estimatedItemSize={ROW_HEIGHT.schedule}
      alwaysRenderKeys={alwaysRenderKeys}
      anchorKey={anchorId}
      onAnchorPosition={anchorMoved}
      empty={
        loading ? (
          <ActivityIndicator accessibilityLabel="Loading games" />
        ) : empty ? (
          <Empty text="No games scheduled." />
        ) : null
      }
      footer={
        <>
          <PagedListEnd list={list} />
          {onCreateGame != null && (
            <AddEventCard variant="game" onPress={onCreateGame} />
          )}
        </>
      }
      onEndReached={() => {
        loadMore().catch(() => undefined)
      }}
      onStartReached={atRest => {
        loadOlder(atRest).catch(() => undefined)
      }}
    />
  )
}

/** The games with a video, newest first. */
function VideoRows(props: {
  list: PagedRows<GameSummary>
  teamId: string
  nonMemberView: boolean
  onOpen: TeamScreenProps['onOpenGame']
}): React.ReactElement {
  const { list, teamId, nonMemberView, onOpen } = props
  const { rows, loading, empty, loadMore } = list
  const styles = getStyles(useTheme())
  const renderRow = useCallback(
    (game: GameSummary) => (
      <View style={styles.row}>
        <GameCard
          game={game}
          mode="videos"
          nonMemberView={nonMemberView}
          teamId={teamId}
          onOpen={onOpen}
        />
      </View>
    ),
    [nonMemberView, onOpen, styles.row, teamId]
  )
  return (
    <PagedList
      data={rows}
      keyOf={gameId}
      renderItem={renderRow}
      extraData={nonMemberView}
      estimatedItemSize={ROW_HEIGHT.videos}
      empty={
        loading ? (
          <ActivityIndicator accessibilityLabel="Loading games" />
        ) : empty ? (
          <Empty text="No game has a video attached yet." />
        ) : null
      }
      footer={<PagedListEnd list={list} />}
      onEndReached={() => {
        loadMore().catch(() => undefined)
      }}
    />
  )
}

/** The line under a roster name; see `peopleSubtitle`. */
export const rosterSubtitle = peopleSubtitle
export { inheritedPill }

/** `1st Place`, `2nd Place`, `11th Place`. */
function placeLabel(place: number): string {
  const rest = place % 100
  const suffix =
    rest >= 11 && rest <= 13
      ? 'th'
      : place % 10 === 1
        ? 'st'
        : place % 10 === 2
          ? 'nd'
          : place % 10 === 3
            ? 'rd'
            : 'th'
  return `${place}${suffix} Place`
}

const GameCard = memo(function GameCard(props: {
  game: GameSummary
  mode: 'schedule' | 'videos'
  teamId: string
  nonMemberView?: boolean
  onOpen: (gameId: string, title: string, options?: GameListOpenOptions) => void
}): React.ReactElement {
  const { game, teamId, onOpen, mode, nonMemberView } = props
  const options = gameListOptions(game, mode, nonMemberView)
  const styles = getStyles(useTheme())
  const narrow = useBreakpoint() === 'phone'
  const result = resultFor(game, teamId)
  // The same row the videos list uses, written from this team's point of view.
  const lines = matchupLines(game, teamId)
  const detail = [
    narrow ? shortDateNoWeekday(game.startAt) : shortDate(game.startAt),
    shortTime(game.startAt),
    videoCountLabel(game.videoCount)
  ]
    .filter(part => part !== '')
    .join(' · ')

  return (
    <Card>
      {mode === 'schedule' ? (
        <ScheduleRow
          first={eventName(game) ?? lines.second}
          startAt={game.startAt}
          isGameLive={game.isGameLive}
          isUmpire={game.isUmpire}
          venue={game.venue}
          status={game.status}
          awayScore={game.awayScore}
          homeScore={game.homeScore}
          videoCount={game.videoCount}
          result={result}
          pendingApproval={game.pendingApproval}
          cancellationReason={game.cancellationReason}
          withdrawnByTeamName={game.withdrawnByTeamName}
          onPress={
            options == null
              ? undefined
              : () => {
                  onOpen(
                    game.id,
                    [lines.first, lines.second]
                      .filter(line => line !== '')
                      .join(' '),
                    options
                  )
                }
          }
        />
      ) : (
        <GameRow
          first={lines.first}
          second={lines.second}
          detail={detail}
          venue={game.venue}
          posterUrl={game.posterUrl}
          length={
            game.durationSec == null ? undefined : clock(game.durationSec)
          }
          badgeLabel={
            game.pendingApproval
              ? 'Pending approval'
              : game.status === 'cancelled'
                ? 'Canceled'
                : result?.label
          }
          badgeTone={
            game.pendingApproval ? 'neutral' : (result?.tone ?? 'neutral')
          }
          onPress={
            options == null
              ? undefined
              : () => {
                  onOpen(
                    game.id,
                    [lines.first, lines.second]
                      .filter(line => line !== '')
                      .join(' '),
                    options
                  )
                }
          }
        />
      )}
      {game.status === 'cancelled' &&
        game.cancellationReason === 'withdrawal' && (
          <Text style={styles.muted}>
            Withdrawal — {game.withdrawnByTeamName ?? 'A team'} withdrew
          </Text>
        )}
      {game.ingestStatus === 'scoreMismatch' && (
        <Text style={styles.warning}>
          The plays and the reported score disagree, so highlights are withheld.
        </Text>
      )}
    </Card>
  )
})

/**
 * A game on the team's schedule: the nav bar schedule's row, with the one
 * difference that the team's own name is not repeated on every line. The row
 * says only who it is against, and where — `@ Owls`, `vs Hawks`.
 */
const ScheduleCard = memo(function ScheduleCard(props: {
  client: TeamStationClient
  game: GameSummary
  teamId: string
  onOpen: TeamScreenProps['onOpenGame']
  onAnswered: (gameId: string, counts: PlayerRsvpCounts) => void
}): React.ReactElement {
  const { client, game, teamId, onOpen, onAnswered } = props
  const lines = matchupLines(game, teamId)
  // A pending game opens its proposal, and only for those allowed to see it.
  const options = gameListOptions(game, 'schedule')
  const rowProps = {
    first: eventName(game) ?? lines.second,
    startAt: game.startAt,
    isGameLive: game.isGameLive,
    isUmpire: game.isUmpire,
    venue: game.venue,
    status: game.status,
    awayScore: game.awayScore,
    homeScore: game.homeScore,
    videoCount: game.videoCount,
    result: resultFor(game, teamId),
    pendingApproval: game.pendingApproval,
    cancellationReason: game.cancellationReason,
    withdrawnByTeamName: game.withdrawnByTeamName,
    onPress:
      options == null
        ? undefined
        : () => {
            onOpen(
              game.id,
              [lines.first, lines.second].filter(line => line !== '').join(' '),
              options
            )
          }
  }
  return (
    <Card>
      {game.playerRsvps == null ? (
        <ScheduleRow {...rowProps} />
      ) : (
        <RsvpScheduleRow
          {...rowProps}
          footer={
            // Nothing to answer and nothing to count: the compact card.
            hasScheduleRsvpLine(game) ? (
              <ScheduleRsvpControl
                key={`${teamId}/${game.id}`}
                client={client}
                game={game}
                teamId={teamId}
                label={eventName(game) ?? lines.second}
                onAnswered={counts => {
                  onAnswered(game.id, counts)
                }}
              />
            ) : null
          }
        />
      )}
    </Card>
  )
})

function Empty(props: { text: string }): React.ReactElement {
  const styles = getStyles(useTheme())
  return (
    <Card>
      <Text style={styles.muted}>{props.text}</Text>
    </Card>
  )
}

/** `.313`, the way a batting average is written, or `—` when there is none. */
function rate(value: number | undefined): string {
  if (value == null) return '—'
  return value.toFixed(3).replace(/^0/, '')
}

function seasonStats(standing: StandingsRow | undefined): Stat[] {
  if (standing == null) {
    return [{ label: 'Record', value: '—', note: 'No standings yet' }]
  }
  const perGame = (total: number): string =>
    standing.played === 0 ? '—' : `${(total / standing.played).toFixed(1)} / gm`
  return [
    {
      label: 'Record',
      value: `${standing.w}–${standing.l}${standing.t > 0 ? `–${standing.t}` : ''}`,
      note: `${standing.played} played`
    },
    {
      label: 'Win %',
      value: standing.winningPct == null ? '—' : rate(standing.winningPct)
    },
    {
      label: 'Runs for',
      value: String(standing.runsFor),
      note: perGame(standing.runsFor)
    },
    {
      label: 'Runs against',
      value: String(standing.runsAgainst),
      note: perGame(standing.runsAgainst)
    },
    {
      label: 'Run diff',
      value: `${standing.runDifferential >= 0 ? '+' : ''}${standing.runDifferential}`
    }
  ]
}

const getStyles = cacheStyles((theme: Theme) => ({
  headerHandoff: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceXsRem)
  },
  headerName: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.0625),
    fontWeight: '700',
    color: theme.headerTextColor,
    textAlign: 'center'
  },
  section: {
    gap: theme.rem(theme.spaceMdRem)
  },
  // A list's rows are placed one by one, so its gap is on each of them.
  row: {
    paddingBottom: theme.rem(theme.spaceMdRem)
  },
  identity: {
    gap: theme.rem(theme.spaceMdRem)
  },
  identityTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.rem(theme.spaceMdRem)
  },
  identityTopCompact: { gap: theme.rem(theme.spaceSmRem) },
  identitySpace: { flex: 1 },
  crest: {
    width: theme.rem(3.25),
    height: theme.rem(3.25),
    borderRadius: theme.rem(theme.radiusRem),
    backgroundColor: theme.scoreboardBackground,
    alignItems: 'center',
    justifyContent: 'center'
  },
  crestText: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '700',
    color: theme.scoreboardAccentColor
  },
  publicGear: {
    width: theme.rem(2),
    height: theme.rem(2),
    borderRadius: theme.rem(1),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.containerBackgroundColor
  },
  // As tall as the row, the place pinned to its top and the gear or Follow
  // to its bottom.
  identityEnd: {
    alignSelf: 'stretch',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: theme.rem(theme.spaceXsRem)
  },
  identityEndLevel: {
    alignSelf: 'center'
  },
  // The bottom corner, with or without a place above it.
  gear: {
    alignSelf: 'flex-start'
  },
  identityText: {
    flex: 1,
    gap: theme.rem(0.125)
  },
  teamName: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.5),
    fontWeight: '700',
    letterSpacing: theme.rem(-0.02),
    color: theme.primaryTextColor
  },
  teamMeta: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  divider: {
    height: 1,
    backgroundColor: theme.defaultBorderColor
  },
  muted: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.secondaryTextColor
  },
  warning: {
    marginTop: theme.rem(theme.spaceSmRem),
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.liveColor
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))

/**
 * The line under a staff name: `Coach · Scorekeeper`. The flags read as the
 * role switches name them; a function rather than a label table, which
 * Tess's sitemap would read as the team's tabs.
 */
export function staffSubtitle(person: StaffEntry): string {
  return person.roles.map(roleLabel).join(' · ')
}

function roleLabel(role: Role): string {
  return role === 'admin' ? 'Admin' : flagLabel(role)
}
