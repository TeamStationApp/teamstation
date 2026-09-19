import React, { useEffect, useState } from 'react'
import { Text, View } from 'react-native'

import type {
  GameStationClient,
  SeasonGame,
  SeasonSummary,
  StandingsRow,
  TeamSummary
} from '../../common/api'
import {
  Badge,
  Card,
  Emblem,
  GameRow,
  initialsOf,
  ListRow,
  ManageGear,
  PillTabs,
  Screen,
  SectionHeader,
  StatGrid,
  useBreakpoint
} from '../components'
import { gameCountLabel, videoCountLabel } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import {
  clock,
  matchupLines,
  shortDate,
  shortDateNoWeekday,
  shortTime
} from './format'
import { gamesFor, type When } from './whenFilter'

export interface SeasonScreenProps {
  client: GameStationClient
  season: SeasonSummary
  onOpenGame: (
    gameId: string,
    title: string,
    options?: { tab?: 'watch' | 'boxScore'; autoPlay?: boolean }
  ) => void
  onOpenTeam: (team: TeamSummary) => void
  /** The gear in the card's corner, for an administrator of this season. */
  onManage?: () => void
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
  /** Which games the schedule is filtered to, from the address. */
  initialWhen?: When
  /** Tells the shell which filter is showing. */
  onWhen?: (when: When) => void
}

type TabId = 'schedule' | 'teams' | 'standings'

function tabOf(id: string | undefined): TabId {
  return TABS.some(item => item.id === id) ? (id as TabId) : 'schedule'
}
const TABS = [
  { id: 'schedule' as const, label: 'Schedule' },
  { id: 'teams' as const, label: 'Teams' },
  { id: 'standings' as const, label: 'Standings' }
]

const WHEN_TABS = [
  { id: 'past' as const, label: 'Past' },
  { id: 'upcoming' as const, label: 'Upcoming' },
  { id: 'all' as const, label: 'All' }
]

/**
 * A season: every game in it, who is in it, and where they stand.
 *
 * Standings is a third tab rather than a panel on the schedule. The design put
 * a league table nowhere at all, but the data has been sitting behind
 * `/seasons/:id/standings` since the ingest landed, and a table of who is
 * winning is the thing a league page is *for*.
 *
 * The schedule's own past/upcoming filter is the same `PillTabs`, one size
 * down. Two strips on one screen could be confusing, so the section header
 * sits between them and the lower one never carries the screen's own sections.
 */
export function SeasonScreen(props: SeasonScreenProps): React.ReactElement {
  const {
    client,
    season,
    onOpenGame,
    onOpenTeam,
    initialTab,
    onTab,
    initialWhen,
    onWhen,
    onManage
  } = props
  const styles = getStyles(useTheme())
  const narrow = useBreakpoint() === 'phone'

  const [tab, setTab] = useState<TabId>(tabOf(initialTab))
  const [when, setWhen] = useState<When>(initialWhen ?? 'past')
  const [games, setGames] = useState<SeasonGame[]>([])
  const [teams, setTeams] = useState<TeamSummary[]>([])
  const [standings, setStandings] = useState<StandingsRow[]>([])
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
      const [loadedGames, loadedTeams, loadedStandings] = await Promise.all([
        client.seasonGames(season.id),
        client.seasonTeams(season.id),
        client.standings(season.id)
      ])
      if (cancelled) return
      setGames(loadedGames)
      setTeams(loadedTeams)
      setStandings(loadedStandings)
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
  }, [client, season.id])

  const shown = gamesFor(games, when)

  return (
    <Screen>
      <Card style={styles.identity}>
        {/*
          On the name's own row. A season's card has no place pill to make
          room for, and anywhere lower costs the card a line of height for a
          single glyph.
        */}
        <View style={styles.identityTop}>
          {/*
            The season's own mark, from the organisation it was imported
            from. Seasons made by hand have none, and the glyph
            stands in exactly as it does on the home list.
          */}
          <Emblem uri={season.logoUrl} fallback="▦" size={2.25} />
          <Text style={styles.seasonName}>{season.name}</Text>
          {onManage != null && (
            <ManageGear
              client={client}
              scopeType="season"
              scopeId={season.id}
              onPress={onManage}
            />
          )}
        </View>
        <Text style={styles.seasonMeta}>
          {season.year}
          {season.term == null ? '' : ` · ${season.term}`}
          {season.ageGroup == null ? '' : ` · ${season.ageGroup}`}
        </Text>
        <StatGrid
          columns={3}
          stats={[
            { label: 'Teams', value: String(season.teams) },
            { label: 'Games', value: String(season.games) },
            { label: 'Videos', value: String(season.videos) }
          ]}
        />
      </Card>

      <PillTabs
        tabs={TABS}
        selected={tab}
        onSelect={next => {
          setTab(next)
          onTab?.(next)
        }}
        size="compact"
        accessibilityLabel="Season sections"
      />

      {error != null && <Text style={styles.error}>{error}</Text>}
      {loading && <Text style={styles.muted}>Loading…</Text>}

      {!loading && tab === 'schedule' && (
        <View style={styles.section}>
          {/*
            Compact and natural width, exactly as the videos list and the
            schedule draw it. Stretched and full size it was painted the same
            as the section row above it, so `Schedule · Teams · Standings`
            over `Past · Upcoming · All` read as one six-item control with two
            things selected.
          */}
          <PillTabs
            tabs={WHEN_TABS}
            selected={when}
            onSelect={next => {
              setWhen(next)
              onWhen?.(next)
            }}
            size="compact"
            accessibilityLabel="Which games"
          />
          <SectionHeader title="Schedule" note={gameCountLabel(shown.length)} />
          {shown.length === 0 ? (
            <Card>
              <Text style={styles.muted}>Nothing here yet.</Text>
            </Card>
          ) : (
            shown.map(game => {
              const lines = matchupLines(game)
              const detail = [
                narrow
                  ? shortDateNoWeekday(game.startAt)
                  : shortDate(game.startAt),
                shortTime(game.startAt),
                videoCountLabel(game.videoCount)
              ]
                .filter(part => part !== '')
                .join(' · ')
              return (
                <Card key={game.id}>
                  <GameRow
                    first={lines.first}
                    second={lines.second}
                    detail={detail}
                    venue={game.venue}
                    posterUrl={game.posterUrl}
                    length={
                      game.durationSec == null
                        ? undefined
                        : clock(game.durationSec)
                    }
                    // A game being played now says so instead of showing a
                    // score that is still changing.
                    badgeLabel={
                      game.isLive
                        ? 'live'
                        : game.awayScore == null
                          ? undefined
                          : `${game.awayScore}–${game.homeScore}`
                    }
                    badgeTone={game.isLive ? 'live' : 'neutral'}
                    onPress={() => {
                      onOpenGame(game.id, `${lines.first} ${lines.second}`, {
                        autoPlay: game.videoCount > 0
                      })
                    }}
                  />
                </Card>
              )
            })
          )}
        </View>
      )}

      {!loading && tab === 'teams' && (
        <View style={styles.section}>
          <SectionHeader title="Teams" note={String(teams.length)} />
          <Card>
            {teams.map((team, index) => (
              <View key={team.id}>
                {index > 0 && <View style={styles.divider} />}
                <ListRow
                  title={team.name}
                  subtitle={teamSubtitle(team)}
                  emblem={initialsOf(team.name)}
                  emblemUri={team.logoUrl}
                  onPress={() => {
                    onOpenTeam(team)
                  }}
                />
              </View>
            ))}
          </Card>
        </View>
      )}

      {!loading && tab === 'standings' && (
        <View style={styles.section}>
          <SectionHeader title="Standings" note={`${standings.length} teams`} />
          {standings.length === 0 ? (
            <Card>
              <Text style={styles.muted}>
                No games have been scored in this season yet.
              </Text>
            </Card>
          ) : (
            <Card flush>
              <View style={[styles.tableRow, styles.tableHead]}>
                <Text style={[styles.cellName, styles.cellHead]}>Team</Text>
                <Text style={[styles.cell, styles.cellHead]}>W</Text>
                <Text style={[styles.cell, styles.cellHead]}>L</Text>
                <Text style={[styles.cell, styles.cellHead]}>RF</Text>
                <Text style={[styles.cell, styles.cellHead]}>RA</Text>
                <Text style={[styles.cell, styles.cellHead]}>DIFF</Text>
              </View>
              {standings.map((row, index) => (
                <View key={row.teamId} style={styles.tableRow}>
                  <View style={styles.rank}>
                    <Text style={styles.rankText}>{index + 1}</Text>
                  </View>
                  <Text style={styles.cellName} numberOfLines={1}>
                    {row.teamName}
                  </Text>
                  <Text style={styles.cell}>{row.w}</Text>
                  <Text style={styles.cell}>{row.l}</Text>
                  <Text style={styles.cell}>{row.runsFor}</Text>
                  <Text style={styles.cell}>{row.runsAgainst}</Text>
                  <Text style={styles.cell}>
                    {row.runDifferential >= 0 ? '+' : ''}
                    {row.runDifferential}
                  </Text>
                </View>
              ))}
            </Card>
          )}
          {standings[0] != null && (
            <Badge label={`${standings[0].teamName} leads`} tone="honour" />
          )}
        </View>
      )}
    </Screen>
  )
}

/** `12–3`, or the short name when there is no record yet. */
function teamSubtitle(team: TeamSummary): string | undefined {
  if (team.record != null) {
    const { w, l, t } = team.record
    return t > 0 ? `${w}–${l}–${t}` : `${w}–${l}`
  }
  return team.shortName ?? undefined
}

const getStyles = cacheStyles((theme: Theme) => ({
  identityTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.rem(theme.spaceSmRem)
  },
  section: {
    gap: theme.rem(theme.spaceMdRem)
  },
  identity: {
    gap: theme.rem(theme.spaceMdRem)
  },
  seasonName: {
    // Flexed, so a long name wraps rather than pushing the gear off the card.
    flex: 1,
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.5),
    fontWeight: '700',
    letterSpacing: theme.rem(-0.02),
    color: theme.primaryTextColor
  },
  seasonMeta: {
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
  rank: {
    width: theme.rem(1.5),
    alignItems: 'center'
  },
  rankText: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    fontWeight: '700',
    color: theme.secondaryTextColor
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
    width: theme.rem(2.5),
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
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
