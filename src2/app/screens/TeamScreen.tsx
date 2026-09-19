import React, { useEffect, useMemo, useState } from 'react'
import { Text, View } from 'react-native'

import type {
  BattingRow,
  GameStationClient,
  GameSummary,
  RosterEntry,
  StandingsRow,
  TeamSummary
} from '../../common/api'
import {
  Badge,
  Card,
  Emblem,
  GameRow,
  HandoffView,
  initialsOf,
  ListRow,
  ManageGear,
  PillTabs,
  Screen,
  SectionHeader,
  type Stat,
  StatGrid,
  useBreakpoint,
  useHandoff,
  useHeaderHandoff,
  useHeaderSlot
} from '../components'
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
import { gamesFor } from './whenFilter'

export interface TeamScreenProps {
  client: GameStationClient
  team: TeamSummary
  /** The gear in the card's corner, for somebody who administers this team. */
  onManage?: () => void
  onOpenGame: (
    gameId: string,
    title: string,
    options?: { tab?: 'watch' | 'boxScore'; autoPlay?: boolean }
  ) => void
  /**
   * A name on the roster. The team travels with it, so the player's stats open
   * on this team rather than on a career total nobody asked for.
   */
  onOpenPlayer?: (
    userId: string,
    name: string,
    from?: { seasonId?: string; teamId?: string }
  ) => void
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
    initialTab,
    onTab,
    onManage
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)

  // The team's name slides up into the header as its card goes under, and
  // comes back down when it returns. The header carries no title for this
  // screen otherwise: the name is on the card a few pixels below it.
  const { headerHeight } = useHeaderSlot()
  const handoff = useHandoff(headerHeight)
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
  const [standing, setStanding] = useState<StandingsRow | undefined>(undefined)
  /** Where this team sits in its season, 1 for first. */
  const [place, setPlace] = useState<number | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)

  // An address that names a section this screen does not have showed the
  // default while still claiming the other one. Say what is actually on
  // screen, correcting the entry rather than adding one.
  useEffect(() => {
    if (initialTab != null && initialTab !== tab) onTab?.(tab, true)
    // Once, against the address the screen opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      const loadedGames = await client.teamGames(team.id)
      if (cancelled) return
      setGames(loadedGames)

      const seasonId = loadedGames.find(game => game.seasonId != null)?.seasonId
      const [loadedRoster, loadedBatting, standings] = await Promise.all([
        client.roster(team.id),
        client.teamStats(team.id, seasonId ?? undefined),
        seasonId == null
          ? Promise.resolve<StandingsRow[]>([])
          : client.standings(seasonId)
      ])
      if (cancelled) return
      setRoster(loadedRoster)
      setBatting(loadedBatting)
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
          setError(caught instanceof Error ? caught.message : 'Cannot load')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [client, team.id])

  const withVideo = games.filter(game => game.videoCount > 0)
  // The same rule as the schedule and the season page, not a fourth copy of
  // it. Counting the unscored ones made a February fixture nobody ever scored
  // one of the games still to play, on both sides' pages — and the list below
  // sorts it to the bottom as a past game, so the screen disagreed with its
  // own header.
  const upcoming = gamesFor(games, 'upcoming')

  return (
    <Screen onScroll={handoff.handleScroll}>
      <Card style={styles.identity} ref={handoff.ref}>
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
          {place != null && <Badge label={placeLabel(place)} tone="honour" />}
        </View>
        {/*
          The bottom right corner, floated rather than laid out: in the flow
          it pushed the card taller and left a band of empty space under the
          content, which reads as the page having lost its rhythm. The place
          pill keeps the top right, and the two never share a corner.
        */}
        {onManage != null && (
          <View style={styles.gearCorner}>
            <ManageGear
              client={client}
              scopeType="team"
              scopeId={team.id}
              onPress={onManage}
            />
          </View>
        )}
      </Card>

      <PillTabs
        tabs={TABS}
        selected={tab}
        onSelect={next => {
          setTab(next)
          onTab?.(next)
        }}
        size="compact"
        accessibilityLabel="Team sections"
      />

      {error != null && <Text style={styles.error}>{error}</Text>}
      {loading && <Text style={styles.muted}>Loading…</Text>}

      {!loading && tab === 'videos' && (
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
                teamId={team.id}
                onOpen={onOpenGame}
              />
            ))
          )}
        </View>
      )}

      {!loading && tab === 'schedule' && (
        <View style={styles.section}>
          <SectionHeader
            title="Schedule"
            note={`${games.length} games, ${upcoming.length} to play`}
          />
          {games.length === 0 ? (
            <Empty text="No games scheduled." />
          ) : (
            games.map(game => (
              <GameCard
                key={game.id}
                game={game}
                teamId={team.id}
                onOpen={onOpenGame}
              />
            ))
          )}
        </View>
      )}

      {!loading && tab === 'team' && (
        <>
          {roster.length === 0 && (
            <Empty text="Nobody has been added to this team yet." />
          )}
          {/*
            Coaches, then players, then the people who can see the team
            without being on it — however they were given the right, on the
            team, its season or its league. The server decides who is in which
            group; this only draws them in order.
          */}
          {(
            [
              ['coach', 'Coaches'],
              ['player', 'Players'],
              ['follower', 'Followers']
            ] as const
          ).map(([group, heading]) => {
            const people = roster.filter(person => person.group === group)
            if (people.length === 0) return null
            return (
              <View key={group} style={styles.section}>
                <SectionHeader title={heading} note={String(people.length)} />
                <Card>
                  {people.map((person, index) => (
                    <View key={person.userId}>
                      {index > 0 && <View style={styles.divider} />}
                      <ListRow
                        title={person.shortName}
                        subtitle={
                          person.positions.length > 0
                            ? person.positions.join(' · ')
                            : undefined
                        }
                        emblem={initialsOf(person.shortName)}
                        emblemUri={person.avatarUrl}
                        emblemShape="circle"
                        trailing={
                          // An empty string is not a jersey number. Without
                          // this the row reads as a bare `#`.
                          person.jersey == null || person.jersey.trim() === ''
                            ? undefined
                            : `#${person.jersey.trim()}`
                        }
                        onPress={
                          onOpenPlayer == null
                            ? undefined
                            : () => {
                                onOpenPlayer(person.userId, person.shortName, {
                                  teamId: team.id
                                })
                              }
                        }
                      />
                    </View>
                  ))}
                </Card>
              </View>
            )
          })}
        </>
      )}

      {!loading && tab === 'stats' && (
        <View style={styles.section}>
          <SectionHeader title="Season performance" />
          <Card>
            <StatGrid stats={seasonStats(standing)} columns={2} />
          </Card>

          <SectionHeader title="Batting" note={`${batting.length} players`} />
          {batting.length === 0 ? (
            <Empty text="No plays have been ingested for this team yet." />
          ) : (
            <Card flush>
              <BattingTable rows={batting} />
            </Card>
          )}
        </View>
      )}
    </Screen>
  )
}

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
  teamId: string
  onOpen: (
    gameId: string,
    title: string,
    options?: { tab?: 'watch' | 'boxScore'; autoPlay?: boolean }
  ) => void
}): React.ReactElement {
  const { game, teamId, onOpen } = props
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
      <GameRow
        first={lines.first}
        second={lines.second}
        detail={detail}
        venue={game.venue}
        posterUrl={game.posterUrl}
        length={game.durationSec == null ? undefined : clock(game.durationSec)}
        badgeLabel={result?.label}
        badgeTone={result?.tone ?? 'neutral'}
        onPress={() => {
          onOpen(game.id, `${lines.first} ${lines.second}`, {
            autoPlay: game.videoCount > 0
          })
        }}
      />
      {game.ingestStatus === 'scoreMismatch' && (
        <Text style={styles.warning}>
          The plays and the reported score disagree, so highlights are withheld.
        </Text>
      )}
    </Card>
  )
}

/** The batting table, which is the one place a real grid beats stacked rows. */
function BattingTable(props: { rows: BattingRow[] }): React.ReactElement {
  const { rows } = props
  const styles = getStyles(useTheme())
  const sorted = [...rows].sort((a, b) => b.pa - a.pa)

  return (
    <View>
      <View style={[styles.tableRow, styles.tableHead]}>
        <Text style={[styles.cellName, styles.cellHead]}>Player</Text>
        <Text style={[styles.cell, styles.cellHead]}>PA</Text>
        <Text style={[styles.cell, styles.cellHead]}>AB</Text>
        <Text style={[styles.cell, styles.cellHead]}>H</Text>
        <Text style={[styles.cell, styles.cellHead]}>R</Text>
        <Text style={[styles.cell, styles.cellHead]}>RBI</Text>
        <Text style={[styles.cell, styles.cellHead]}>AVG</Text>
      </View>
      {sorted.map(row => (
        <View key={row.userId} style={styles.tableRow}>
          <Text style={styles.cellName} numberOfLines={1}>
            {row.shortName ?? 'Unknown'}
          </Text>
          <Text style={styles.cell}>{row.pa}</Text>
          <Text style={styles.cell}>{row.ab}</Text>
          <Text style={styles.cell}>{row.h}</Text>
          <Text style={styles.cell}>{row.r}</Text>
          <Text style={styles.cell}>{row.rbi}</Text>
          <Text style={styles.cell}>{rate(row.rates.avg)}</Text>
        </View>
      ))}
    </View>
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
  gearCorner: {
    position: 'absolute',
    right: theme.rem(theme.spaceMdRem),
    bottom: theme.rem(theme.spaceMdRem)
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
    paddingVertical: theme.rem(theme.spaceSmRem),
    gap: theme.rem(theme.spaceXsRem)
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
  cellName: {
    flex: 1,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.primaryTextColor
  },
  cell: {
    width: theme.rem(2.75),
    textAlign: 'right',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    fontWeight: '600',
    color: theme.primaryTextColor
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
