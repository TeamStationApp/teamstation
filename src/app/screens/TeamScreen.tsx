import React, { useEffect, useMemo, useState } from 'react'
import { Pressable, Text, useWindowDimensions, View } from 'react-native'

import type {
  BattingRow,
  GameSummary,
  PitchingRow,
  RosterEntry,
  StandingsRow,
  TeamStationClient,
  TeamSummary
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { eventName } from '../../common/eventInfo'
import type { GroupDetail } from '../../common/publicGroups'
import {
  Badge,
  Card,
  CardBand,
  Emblem,
  GameRow,
  HandoffView,
  Icon,
  initialsOf,
  ManageGear,
  PillBand,
  PillTabs,
  PinnedContent,
  PinnedSpacer,
  RsvpScheduleRow,
  ScheduleRow,
  Screen,
  SectionHeader,
  type Stat,
  StatGrid,
  useBreakpoint,
  useHeaderHandoff,
  usePinnedHandoff,
  usePinnedTabs,
  webStyle,
  WideTable
} from '../components'
import { FollowButton } from '../components/FollowButton'
import {
  inheritedPill,
  PeopleList,
  peopleSubtitle
} from '../components/PeopleList'
import { lstrings, videoCountLabel } from '../locales/strings'
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
import { PublicTeamContent } from './PublicTeamContent'
import { ScheduleRsvpControl } from './ScheduleRsvpControl'
import {
  battingColumns,
  pitchingColumns,
  STAT_COLUMN_GAP_REM,
  type StatColumn,
  statColumnWidths
} from './statColumns'
import { chronological, gamesFor, nextGameIndex } from './whenFilter'

export interface TeamScreenProps {
  client: TeamStationClient
  team: TeamSummary
  /**
   * The public projection, for somebody not signed in: nobody signed in
   * reads anything else of a team.
   */
  publicDetail?: GroupDetail
  /**
   * Somebody signed in who is not a member, following the team or not: the
   * members' page less what is kept for members. No batting or pitching, no
   * video library, and no player pages, which answer them `404`. The
   * schedule carries the thumbnails the Videos tab would have.
   */
  nonMemberView?: boolean
  /** Revalidate private collections when the access adapter refreshes. */
  refreshRevision?: number
  /** The gear in the card's corner, for somebody who administers this team. */
  onManage?: () => void
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
    userId: number,
    name: string,
    from?: { seasonId?: string; teamId?: string; onTeam?: string }
  ) => void
  /**
   * Somebody on the roster who is not a player, opened as their person
   * profile from this team (its canonical id): offered only with
   * `managesPeople`.
   */
  onOpenPerson?: (userId: number, name: string, teamId: string) => void
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
}

type TabId = 'videos' | 'schedule' | 'team' | 'stats'

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
  { id: 'stats' as const, label: 'Stats' }
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
    publicDetail,
    nonMemberView = false,
    refreshRevision
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)

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
          <Emblem
            uri={team.logoUrl}
            fallback={initialsOf(team.name)}
            size={1.75}
          />
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
  const [games, setGames] = useState<GameSummary[]>([])
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
      const loadedGames = await client.teamGames(team.id)
      if (cancelled) return
      setGames(loadedGames)

      const seasonId = loadedGames.find(game => game.seasonId != null)?.seasonId
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
            setGames([])
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
  }, [client, team.id, publicDetail, nonMemberView, refreshRevision])

  const follows = onManage == null && (publicDetail != null || nonMemberView)
  const withVideo = games.filter(game => game.videoCount > 0)
  // The same rule as the schedule and the season page, not a fourth copy of
  // it. Counting the unscored ones made a February fixture nobody ever scored
  // one of the games still to play, on both sides' pages — and the list below
  // sorts it to the bottom as a past game, so the screen disagreed with its
  // own header.
  const upcoming = gamesFor(games, 'upcoming')
  // The season in the order it is played, as the nav bar's schedule draws it.
  const schedule = chronological(games)
  const next = nextGameIndex(schedule)

  // The card scrolls away and the pills pin under the header; a selected tab
  // starts directly under them, the schedule at its next game.
  const { pinned, selectTab } = usePinnedTabs({
    head,
    ready: !loading,
    tab,
    anchorOnRow: tab === 'schedule' && next >= 0
  })

  return (
    <Screen {...pinned.screen}>
      <CardBand part={pinned.cardBand}>
        <Card style={styles.identity}>
          <View style={styles.identityTop}>
            <Emblem
              uri={team.logoUrl}
              fallback={initialsOf(team.name)}
              size={3.5}
            />
            <View style={styles.identityText}>
              <Text style={styles.teamName}>{team.name}</Text>
              {standing != null && (
                <Text style={styles.teamMeta}>
                  {standing.w}–{standing.l}
                  {standing.t > 0 ? `–${standing.t}` : ''} · {standing.played}{' '}
                  played
                </Text>
              )}
            </View>
            {/*
              The right-hand column: the place at the top, and at the bottom
              the gear for an administrator or, for somebody who neither runs
              this team nor belongs to it (the public page, or a non-member's),
              Follow. Laid out rather than floated, so the gear can never be
              drawn over the place, at any width or text size; and in the row
              rather than under it, so a long name wraps beside the column
              instead of running underneath. Follow alone sits level with the
              name, as it always has.
            */}
            {(place != null || follows || onManage != null) && (
              <View
                testID="team-card-end"
                style={[
                  styles.identityEnd,
                  place == null && onManage == null && styles.identityEndLevel
                ]}
              >
                {place != null && (
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
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Team settings"
                        onPress={onManage}
                        style={styles.publicGear}
                      >
                        <Icon
                          name="settings"
                          size={1.25}
                          color={theme.secondaryTextColor}
                        />
                      </Pressable>
                    )}
                  </View>
                )}
              </View>
            )}
          </View>
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

      {publicDetail != null && (
        <PublicTeamContent detail={publicDetail} tab={tab} />
      )}

      {!loading && publicDetail == null && (
        <PinnedContent key={tab} part={pinned.content} testID="teamTabContent">
          {tab === 'videos' && nonMemberView && <MembersOnly />}

          {tab === 'videos' && !nonMemberView && (
            <View style={styles.section}>
              <SectionHeader
                title="Game video library"
                note={`${withVideo.length} with video`}
              />
              {withVideo.length === 0 ? (
                <Empty text="No game has a video attached yet." />
              ) : (
                withVideo.map(game => (
                  <GameCard
                    key={game.id}
                    game={game}
                    mode="videos"
                    teamId={team.id}
                    onOpen={onOpenGame}
                  />
                ))
              )}
            </View>
          )}

          {tab === 'schedule' && (
            <View
              style={styles.section}
              ref={pinned.rowSection.ref}
              onLayout={pinned.rowSection.handleLayout}
            >
              <SectionHeader
                title="Schedule"
                note={`${games.length} games, ${upcoming.length} to play`}
              />
              {schedule.length === 0 ? (
                <Empty text="No games scheduled." />
              ) : (
                schedule.map((game, index) => (
                  <View
                    // The next game's row is its own element, so it is laid
                    // out, and measured, again when the next game changes.
                    key={index === next ? `${game.id}:next` : game.id}
                    testID="scheduleGame"
                    ref={index === next ? pinned.nextRow.ref : undefined}
                    onLayout={
                      index === next ? pinned.nextRow.handleLayout : undefined
                    }
                  >
                    {nonMemberView ? (
                      // A visitor opens recordings from the schedule;
                      // the library itself is kept for members.
                      <GameCard
                        game={game}
                        mode="schedule"
                        teamId={team.id}
                        nonMemberView
                        onOpen={onOpenGame}
                      />
                    ) : (
                      <ScheduleCard
                        client={client}
                        game={game}
                        teamId={team.id}
                        onOpen={onOpenGame}
                      />
                    )}
                  </View>
                ))
              )}
            </View>
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
                  if (person.isPlayer && !nonMemberView && onOpenPlayer != null)
                    return () => {
                      onOpenPlayer(person.userId, person.shortName, {
                        onTeam: team.id
                      })
                    }
                  if (managesPeople && onOpenPerson != null)
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
                <MembersOnly />
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
                      <StatsTable rows={batting} columns={battingColumns} />
                    </Card>
                  )}
                  {pitching.length > 0 && (
                    <>
                      <SectionHeader
                        title="Pitching"
                        note={`${pitching.length} players`}
                      />
                      <Card flush>
                        <StatsTable rows={pitching} columns={pitchingColumns} />
                      </Card>
                    </>
                  )}
                </>
              )}
            </View>
          )}
        </PinnedContent>
      )}
      <PinnedSpacer part={pinned.spacer} />
    </Screen>
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

function GameCard(props: {
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
          venue={game.venue}
          status={game.status}
          awayScore={game.awayScore}
          homeScore={game.homeScore}
          videoCount={game.videoCount}
          result={result}
          pendingApproval={game.pendingApproval}
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
}

/**
 * A game on the team's schedule: the nav bar schedule's row, with the one
 * difference that the team's own name is not repeated on every line. The row
 * says only who it is against, and where — `@ Owls`, `vs Hawks`.
 */
function ScheduleCard(props: {
  client: TeamStationClient
  game: GameSummary
  teamId: string
  onOpen: TeamScreenProps['onOpenGame']
}): React.ReactElement {
  const { client, game, teamId, onOpen } = props
  const lines = matchupLines(game, teamId)
  // A pending game opens its proposal, and only for those allowed to see it.
  const options = gameListOptions(game, 'schedule')
  const rowProps = {
    first: eventName(game) ?? lines.second,
    startAt: game.startAt,
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
            <ScheduleRsvpControl
              key={`${teamId}/${game.id}`}
              client={client}
              game={game}
              teamId={teamId}
              label={eventName(game) ?? lines.second}
            />
          }
        />
      )}
    </Card>
  )
}

/** Header and body share compact widths, including any unusually large value. */
function StatsTable<T extends { userId: number; shortName?: string }>(props: {
  rows: T[]
  columns: Array<StatColumn<T>>
}): React.ReactElement {
  const { rows, columns } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const { fontScale } = useWindowDimensions()
  const widths = statColumnWidths(columns, rows, 0.875, 0.6875, 0.05, fontScale)
  const cellSize = (index: number): { width: number; paddingLeft: number } => {
    const gap = index === 0 ? 0 : STAT_COLUMN_GAP_REM
    return {
      width: theme.rem(widths[index] + gap),
      paddingLeft: theme.rem(gap)
    }
  }
  return (
    <WideTable>
      <View>
        <View style={[styles.tableRow, styles.tableHead]}>
          <Text style={[styles.cellName, styles.cellHead, styles.cellNameHead]}>
            Player
          </Text>
          {columns.map((column, index) => (
            <Text
              key={column.label}
              style={[styles.cell, styles.cellHead, cellSize(index)]}
              numberOfLines={1}
            >
              {column.label}
            </Text>
          ))}
        </View>
        {rows.map(row => (
          <View key={row.userId} style={styles.tableRow}>
            <Text style={styles.cellName} numberOfLines={1}>
              {row.shortName ?? 'Unknown'}
            </Text>
            {columns.map((column, index) => (
              <Text
                key={column.label}
                style={[styles.cell, cellSize(index)]}
                numberOfLines={1}
              >
                {column.value(row)}
              </Text>
            ))}
          </View>
        ))}
      </View>
    </WideTable>
  )
}

/**
 * What a non-member is told in place of the team's videos and its players'
 * figures: the page's own text colour on the page, read rather than skimmed
 * past as a hint, the way the game page says it.
 */
function MembersOnly(): React.ReactElement {
  const styles = getStyles(useTheme())
  return (
    <Text accessibilityRole="alert" style={styles.notice}>
      {lstrings.members_only}
    </Text>
  )
}

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
  identity: {
    gap: theme.rem(theme.spaceMdRem)
  },
  identityTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceMdRem)
  },
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
    marginTop: 'auto'
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
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.rem(theme.spaceMdRem),
    paddingVertical: theme.rem(theme.spaceSmRem)
  },
  tableHead: {
    backgroundColor: theme.containerBackgroundColor
  },
  cellHead: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.6875),
    fontWeight: '700',
    letterSpacing: theme.rem(0.05),
    color: theme.secondaryTextColor
  },
  /** The pinned name cell in the head row, which sits on the head's tint. */
  cellNameHead: {
    backgroundColor: theme.containerBackgroundColor
  },
  cellName: {
    // Wide enough for a name first, then greedy for what a wide window has
    // left over, and never shrinking below the two. Pinned as well, so a row
    // scrolled to its last column is still somebody's — `sticky` is a position
    // React Native has no name for, and this app renders to the DOM.
    flexBasis: theme.rem(7),
    minWidth: theme.rem(7),
    flexGrow: 1,
    flexShrink: 0,
    ...webStyle({ position: 'sticky', left: 0, zIndex: 1 }),
    backgroundColor: theme.cardBackgroundColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.primaryTextColor
  },
  cell: {
    fontVariant: ['tabular-nums'],
    flexShrink: 0,
    textAlign: 'right',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  notice: {
    color: theme.primaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    lineHeight: theme.rem(1.4),
    textAlign: 'center' as const,
    paddingVertical: theme.rem(1)
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
