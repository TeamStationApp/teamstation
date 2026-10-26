import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type {
  BattingRow,
  PitchingRow,
  SeasonGame,
  SeasonSummary,
  StandingsRow,
  TeamStationClient,
  TeamSummary
} from '../../common/api'
import type { GroupRef } from '../../common/groupCreation'
import { localityLabel } from '../../common/locality'
import type { GroupDetail } from '../../common/publicGroups'
import { seasonPeriodLabel } from '../../common/seasonTimeFrames'
import {
  Button,
  Card,
  Emblem,
  GameRow,
  HandoffView,
  initialsOf,
  ManageGear,
  PillTabs,
  ScheduleRow,
  SectionHeader,
  SettingsGear,
  StatGrid,
  useHandoff,
  useHeaderHandoff,
  useHeaderSlot,
  usePaneWidth
} from '../components'
import { ActionList } from '../components/ActionRow'
import { Badge } from '../components/Badge'
import { ChoiceSheet } from '../components/ChoiceSheet'
import { FollowButton } from '../components/FollowButton'
import { SegmentedPill } from '../components/SegmentedPill'
import { StatisticsTable } from '../components/StatisticsTable'
import { StickySectionLayout } from '../components/StickySectionLayout'
import { columnsForWidth } from '../layout/grid'
import { gameCountLabel, videoCountLabel } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { clock, matchupLines, shortDate, shortTime } from './format'
import { type GameListOpenOptions, gameListOptions } from './gameListOptions'
import { GroupRelationshipRow } from './GroupRelationshipRow'
import { LevelPeopleTab } from './LevelPeopleTab'
import { SeasonStandings } from './SeasonStandings'
import { battingColumns, pitchingColumns } from './statColumns'
import { useBreakParent } from './useBreakParent'
import { gamesFor, type When } from './whenFilter'

/** What a season's administrator can do from its Teams tab. */
export interface SeasonManagement {
  /** Ask an existing team in, as a managed child or as a competitor. */
  onAddTeam: (relationship: 'parent' | 'participation') => void
  onCreateTeam: () => void
  onCreatePlaceholder?: () => void
  onOpenRequest?: (id: string) => void
  /** After a relationship is broken: load the page again. */
  onChanged: () => void
}

export interface SeasonPresentationProps {
  client: TeamStationClient
  season: SeasonSummary
  onOpenGame: (
    gameId: string,
    title: string,
    options?: GameListOpenOptions
  ) => void
  onOpenTeam: (team: TeamSummary) => void
  onOpenPlayer?: (
    userId: string,
    name: string,
    from?: { seasonId?: string }
  ) => void
  /** Somebody on the People tab who is not a player, as their profile. */
  onOpenPerson?: (userId: string, name: string) => void
  onSettings?: () => void
  initialTab?: string
  onTab?: (tab: string, correcting?: boolean) => void
  initialWhen?: When
  onWhen?: (when: When) => void
  /** Public callers supply the server's private-view permission. */
  publicDetail?: GroupDetail
  /** Given only to the season's administrators. */
  management?: SeasonManagement
  scheduleActions?: React.ReactNode
}

type TabId = 'standings' | 'schedule' | 'stats' | 'videos' | 'teams' | 'people'
const TABS = [
  { id: 'standings' as const, label: 'Standings' },
  { id: 'schedule' as const, label: 'Schedule' },
  { id: 'stats' as const, label: 'Stats' },
  { id: 'videos' as const, label: 'Videos' },
  { id: 'teams' as const, label: 'Teams' }
]
const PEOPLE_TAB = { id: 'people' as const, label: 'People' }
const WHEN_TABS = [
  { id: 'past' as const, label: 'Past' },
  { id: 'upcoming' as const, label: 'Upcoming' },
  { id: 'all' as const, label: 'All' }
]
const EXHIBITION_TABS = [
  { id: 'inSeason' as const, label: 'In-Season' },
  { id: 'all' as const, label: 'Include Exhibitions' }
] as const

/** One presentation for authorized deep links and public home/discovery links. */
export function SeasonPresentation(
  props: SeasonPresentationProps
): React.ReactElement {
  const {
    client,
    season,
    publicDetail,
    onOpenGame,
    onOpenTeam,
    initialTab,
    onTab,
    initialWhen,
    onWhen
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const width = usePaneWidth()
  const mayView = publicDetail?.canViewPrivate ?? true
  const management = props.management
  // Its members and role holders read the season's people, as the server
  // says on the group's page. Opened from anywhere else, such as Home, the
  // season's group detail is read for that alone; until it answers, the
  // People tab an address asks for is left alone rather than corrected away.
  const [loadedPeople, setLoadedPeople] = useState<boolean | undefined>()
  useEffect(() => {
    if (publicDetail != null) return
    let active = true
    setLoadedPeople(undefined)
    client
      .group({ kind: 'season', id: season.id })
      .then(detail => {
        if (active) setLoadedPeople(detail.canSeePeople === true)
      })
      .catch(() => {
        if (active) setLoadedPeople(false)
      })
    return () => {
      active = false
    }
  }, [client, publicDetail, season.id])
  const seesPeople =
    publicDetail != null
      ? publicDetail.canSeePeople === true
      : loadedPeople === true
  const waitingForPeople =
    initialTab === 'people' && publicDetail == null && loadedPeople == null
  const tabs = [
    ...(mayView
      ? TABS
      : TABS.filter(item => item.id === 'schedule' || item.id === 'teams')),
    ...(seesPeople ? [PEOPLE_TAB] : [])
  ]
  const defaultTab = mayView ? 'standings' : 'schedule'
  const allowedTab = (id?: string): TabId =>
    tabs.some(item => item.id === id) ? (id as TabId) : defaultTab
  const [tab, setTab] = useState<TabId>(allowedTab(initialTab))
  const [when, setWhen] = useState<When>(initialWhen ?? 'past')
  const [includeExhibitions, setIncludeExhibitions] = useState(false)
  const [games, setGames] = useState<SeasonGame[]>([])
  const [teams, setTeams] = useState<TeamSummary[]>([])
  const [standings, setStandings] = useState<StandingsRow[]>([])
  const [batting, setBatting] = useState<BattingRow[]>([])
  const [pitching, setPitching] = useState<PitchingRow[]>([])
  const [loading, setLoading] = useState(mayView)
  const [error, setError] = useState('')
  const [standingsLoading, setStandingsLoading] = useState(mayView)
  const [standingsError, setStandingsError] = useState('')
  const [statsLoading, setStatsLoading] = useState(false)
  const [statsError, setStatsError] = useState('')
  const [seasonRetry, setSeasonRetry] = useState(0)
  const [standingsRetry, setStandingsRetry] = useState(0)
  const [statsRetry, setStatsRetry] = useState(0)
  const seasonLoaded = useRef<{ client: TeamStationClient; id: string }>(null)
  const standingsLoaded = useRef<{
    client: TeamStationClient
    id: string
    includeExhibitions: boolean
  }>(null)
  const statsLoaded = useRef<{ client: TeamStationClient; id: string }>(null)
  const { headerHeight } = useHeaderSlot()
  const handoff = useHandoff(headerHeight)
  const progress = handoff.progress
  const mark = publicDetail?.group.imageUrl ?? season.logoUrl
  useHeaderHandoff(
    useMemo(
      () => (
        <HandoffView progress={progress} style={styles.headerHandoff}>
          <Emblem uri={mark} fallback={initialsOf(season.name)} size={1.75} />
          <Text style={styles.headerName} numberOfLines={1}>
            {season.name}
          </Text>
        </HandoffView>
      ),
      [mark, progress, season.name, styles.headerHandoff, styles.headerName]
    )
  )

  useEffect(() => {
    if (waitingForPeople) return
    const next = allowedTab(initialTab)
    setTab(next)
    if (initialTab != null && initialTab !== next) onTab?.(next, true)
    // Tab validity changes when the server revokes private access.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab, mayView, seesPeople, waitingForPeople])
  useEffect(() => {
    if (initialWhen != null) setWhen(initialWhen)
  }, [initialWhen])

  useEffect(() => {
    let active = true
    setError('')
    if (!mayView) {
      seasonLoaded.current = null
      standingsLoaded.current = null
      statsLoaded.current = null
      setGames([])
      setTeams([])
      setStandings([])
      setBatting([])
      setPitching([])
      setLoading(false)
      return
    }
    const hasLoaded =
      seasonLoaded.current?.client === client &&
      seasonLoaded.current.id === season.id
    setLoading(!hasLoaded)
    Promise.all([client.seasonGames(season.id), client.seasonTeams(season.id)])
      .then(([loadedGames, loadedTeams]) => {
        if (active) {
          seasonLoaded.current = { client, id: season.id }
          setGames(loadedGames)
          setTeams(loadedTeams)
        }
      })
      .catch((caught: unknown) => {
        if (active)
          setError(
            caught instanceof Error ? caught.message : 'Cannot load season'
          )
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [client, mayView, publicDetail, season.id, seasonRetry])

  useEffect(() => {
    if (!mayView) return
    let active = true
    const hasLoaded =
      standingsLoaded.current?.client === client &&
      standingsLoaded.current.id === season.id &&
      standingsLoaded.current.includeExhibitions === includeExhibitions
    setStandingsLoading(!hasLoaded)
    setStandingsError('')
    client
      .standings(season.id, { includeExhibitions })
      .then(rows => {
        if (active) {
          standingsLoaded.current = {
            client,
            id: season.id,
            includeExhibitions
          }
          setStandings(rows)
        }
      })
      .catch((caught: unknown) => {
        if (active)
          setStandingsError(
            caught instanceof Error ? caught.message : 'Cannot load standings'
          )
      })
      .finally(() => {
        if (active) setStandingsLoading(false)
      })
    return () => {
      active = false
    }
  }, [
    client,
    includeExhibitions,
    mayView,
    publicDetail,
    season.id,
    standingsRetry
  ])

  useEffect(() => {
    if (!mayView || tab !== 'stats') return
    let active = true
    const hasLoaded =
      statsLoaded.current?.client === client &&
      statsLoaded.current.id === season.id
    setStatsLoading(!hasLoaded)
    setStatsError('')
    client
      .seasonStats(season.id)
      .then(found => {
        if (active) {
          statsLoaded.current = { client, id: season.id }
          setBatting(found.batting)
          setPitching(found.pitching)
        }
      })
      .catch((caught: unknown) => {
        if (active)
          setStatsError(
            caught instanceof Error ? caught.message : 'Cannot load statistics'
          )
      })
      .finally(() => {
        if (active) setStatsLoading(false)
      })
    return () => {
      active = false
    }
  }, [client, mayView, publicDetail, season.id, tab, statsRetry])

  const shown = gamesFor(games, when)
  const publicShown = gamesFor(publicDetail?.games ?? [], when)
  const withVideo = games
    .filter(game => game.videoCount > 0)
    .sort((a, b) => Date.parse(b.startAt ?? '') - Date.parse(a.startAt ?? ''))
  const chooseTab = (next: TabId): void => {
    setTab(next)
    onTab?.(next)
  }
  const chooseWhen = (next: When): void => {
    setWhen(next)
    onWhen?.(next)
  }
  const openStanding = (id: string): void => {
    const team = teams.find(team => team.id === id)
    if (team != null) onOpenTeam(team)
  }
  const openPlayer =
    props.onOpenPlayer == null
      ? undefined
      : (row: { userId: string; shortName?: string }): void => {
          props.onOpenPlayer?.(row.userId, row.shortName ?? 'Unknown', {
            seasonId: season.id
          })
        }
  const [choosing, setChoosing] = useState<'add' | 'create'>()
  const breaker = useBreakParent(
    client,
    () => {
      management?.onChanged()
    },
    { danger: true, cancelLabel: 'Cancel' }
  )
  const seasonRef: GroupRef = { kind: 'season', id: season.id }
  const childTeamIds = new Set(
    (publicDetail?.children ?? [])
      .filter(child => child.kind === 'team')
      .map(child => child.id)
  )
  const localities = new Map(
    [
      ...(publicDetail?.competingTeams ?? []),
      ...(publicDetail?.children ?? [])
    ].map(team => [team.id, team.locality])
  )
  const teamCards = (list: TeamSummary[]): React.ReactNode => (
    <ActionList bounded={list.length > 0}>
      {list.map(team => {
        const locality = localities.get(team.id)
        const record =
          team.record == null
            ? (team.shortName ?? undefined)
            : `${team.record.w}–${team.record.l}${team.record.t > 0 ? `–${team.record.t}` : ''}`
        return (
          <GroupRelationshipRow
            key={team.id}
            group={{
              id: team.id,
              kind: 'team',
              name: team.name,
              imageUrl: team.logoUrl
            }}
            detail={[
              team.kind === 'external' ? 'Placeholder team' : undefined,
              record,
              locality == null ? undefined : localityLabel(locality)
            ]
              .filter(Boolean)
              .join(' · ')}
            onOpen={() => {
              onOpenTeam(team)
            }}
            label={`Leave ${team.name} from ${season.name}`}
            disabled={breaker.busy}
            onLeave={
              management == null || !childTeamIds.has(team.id)
                ? undefined
                : () => {
                    breaker.review({ kind: 'team', id: team.id }, seasonRef)
                  }
            }
          />
        )
      })}
    </ActionList>
  )
  const teamActions =
    management == null
      ? undefined
      : [
          {
            label: 'Add',
            accessibilityLabel: 'Add team',
            onPress: () => {
              setChoosing('add')
            }
          },
          {
            label: 'Create',
            accessibilityLabel: 'Create team',
            onPress: () => {
              if (management.onCreatePlaceholder == null)
                management.onCreateTeam()
              else setChoosing('create')
            }
          }
        ]
  const categories = [
    { id: 'inSeason', title: 'Teams' },
    { id: 'exhibition', title: 'Exhibition Teams' },
    { id: 'unscheduled', title: 'Unscheduled' }
  ] as const
  const publicTeams =
    publicDetail == null
      ? []
      : [
          ...new Map(
            [
              ...publicDetail.competingTeams,
              ...publicDetail.children.filter(group => group.kind === 'team')
            ].map(team => [team.id, team])
          ).values()
        ]

  return (
    <StickySectionLayout
      onScroll={handoff.handleScroll}
      wide={tab === 'videos'}
      hero={
        <Card style={styles.identity} ref={handoff.ref}>
          <View style={styles.identityTop}>
            <Emblem uri={mark} fallback={initialsOf(season.name)} size={2.25} />
            <Text style={styles.seasonName}>{season.name}</Text>
            {props.onSettings != null && publicDetail == null ? (
              <ManageGear
                client={client}
                scopeType="season"
                scopeId={season.id}
                onPress={props.onSettings}
                accessibilityLabel="Season settings"
              />
            ) : props.onSettings != null ? (
              <SettingsGear
                label="Season settings"
                onPress={props.onSettings}
              />
            ) : (
              // A visitor who neither runs this season nor belongs to it can
              // follow it where an administrator has the gear.
              publicDetail != null &&
              !publicDetail.canViewPrivate && (
                <FollowButton
                  client={client}
                  group={{ kind: 'season', id: season.id }}
                  name={season.name}
                />
              )
            )}
          </View>
          <Text style={styles.seasonMeta}>
            {publicDetail == null
              ? `${season.year}${season.term == null ? '' : ` · ${season.term}`}${season.ageGroup == null ? '' : ` · ${season.ageGroup}`}`
              : seasonPeriodLabel(
                  publicDetail.group.startsOn,
                  publicDetail.group.endsOn
                )}
          </Text>
          {mayView && (
            <StatGrid
              columns={3}
              stats={[
                {
                  label: 'Teams',
                  value: String(
                    loading || error !== '' ? season.teams : teams.length
                  )
                },
                {
                  label: 'Games',
                  value: String(
                    loading || error !== '' ? season.games : games.length
                  )
                },
                {
                  label: 'Videos',
                  value: String(
                    loading || error !== ''
                      ? season.videos
                      : games.reduce(
                          (total, game) => total + game.videoCount,
                          0
                        )
                  )
                }
              ]}
            />
          )}
        </Card>
      }
      sections={
        <PillTabs
          tabs={tabs}
          selected={tab}
          onSelect={chooseTab}
          accessibilityLabel="Season sections"
        />
      }
    >
      {error !== '' && (
        <View style={styles.section}>
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
          {mayView && (
            <Button
              label="Retry season"
              accessibilityLabel="Retry season"
              kind="secondary"
              onPress={() => {
                setSeasonRetry(value => value + 1)
              }}
            />
          )}
        </View>
      )}
      {loading && <Text style={styles.muted}>Loading…</Text>}
      {mayView && tab === 'standings' && (
        <View style={styles.section}>
          <SegmentedPill
            options={EXHIBITION_TABS}
            selected={includeExhibitions ? 'all' : 'inSeason'}
            onSelect={next => {
              setIncludeExhibitions(next === 'all')
            }}
            accessibilityLabel="Standings games"
          />
          <SectionHeader title="Standings" note={`${standings.length} teams`} />
          {standingsError !== '' && (
            <View style={styles.section}>
              <Text accessibilityRole="alert" style={styles.error}>
                {standingsError}
              </Text>
              <Button
                label="Retry standings"
                accessibilityLabel="Retry standings"
                kind="secondary"
                onPress={() => {
                  setStandingsRetry(value => value + 1)
                }}
              />
            </View>
          )}
          {standingsLoading ? (
            <Text style={styles.muted}>Loading standings…</Text>
          ) : (
            standingsError === '' &&
            (standings.length === 0 ? (
              <Card>
                <Text style={styles.muted}>
                  No games have been scored in this season yet.
                </Text>
              </Card>
            ) : (
              <SeasonStandings rows={standings} onOpen={openStanding} />
            ))
          )}
        </View>
      )}
      {tab === 'schedule' && !loading && (
        <View style={styles.section}>
          <PillTabs
            tabs={WHEN_TABS}
            selected={when}
            onSelect={chooseWhen}
            accessibilityLabel="Which games"
          />
          <SectionHeader
            title="Schedule"
            note={gameCountLabel(mayView ? shown.length : publicShown.length)}
          />
          {mayView ? (
            shown.length === 0 ? (
              <Card>
                <Text style={styles.muted}>Nothing here yet.</Text>
              </Card>
            ) : (
              shown.map(game => {
                const lines = matchupLines(game)
                const options = gameListOptions(game, 'schedule')
                return (
                  <Card key={game.id}>
                    <ScheduleRow
                      first={lines.first}
                      second={lines.second}
                      startAt={game.startAt}
                      isGameLive={game.isGameLive}
                      isUmpire={game.isUmpire}
                      venue={game.venue}
                      status={game.status}
                      awayScore={game.awayScore}
                      homeScore={game.homeScore}
                      isLive={game.isLive}
                      videoCount={game.videoCount}
                      pendingApproval={game.pendingApproval}
                      cancellationReason={game.cancellationReason}
                      withdrawnByTeamName={game.withdrawnByTeamName}
                      onPress={
                        options == null
                          ? undefined
                          : () => {
                              onOpenGame(
                                game.id,
                                `${lines.first} ${lines.second}`,
                                options
                              )
                            }
                      }
                    />
                  </Card>
                )
              })
            )
          ) : (
            publicShown.map(game => {
              const options = gameListOptions(game, 'schedule')
              return (
                <Card key={game.id}>
                  <View style={styles.publicGameHeader}>
                    <Text style={[styles.name, styles.publicGameMatchup]}>
                      {game.awayTeam.name} at {game.homeTeam.name}
                    </Text>
                    {game.isUmpire === true && game.status !== 'cancelled' && (
                      <Badge label="UMP" tone="umpire" />
                    )}
                    {game.isGameLive === true &&
                      game.status !== 'cancelled' && (
                        <Badge label="LIVE" tone="live" />
                      )}
                    {game.pendingApproval && (
                      <Text
                        accessibilityLabel={`Pending approval for ${game.awayTeam.name} at ${game.homeTeam.name}`}
                        style={styles.muted}
                      >
                        Pending approval
                      </Text>
                    )}
                  </View>
                  <Text style={styles.muted}>
                    {shortDate(game.startAt)}
                    {shortTime(game.startAt) === ''
                      ? ''
                      : ` · ${shortTime(game.startAt)}`}
                    {game.venue == null ? '' : ` · ${game.venue}`}
                  </Text>
                  {options?.pendingRequestId != null && (
                    <Button
                      label="Open game proposal"
                      accessibilityLabel={`Open game proposal for ${game.awayTeam.name} at ${game.homeTeam.name}`}
                      kind="secondary"
                      onPress={() => {
                        onOpenGame(
                          game.id,
                          `${game.awayTeam.name} at ${game.homeTeam.name}`,
                          options
                        )
                      }}
                    />
                  )}
                  {!game.pendingApproval && (
                    <Text style={styles.muted}>
                      {game.status === 'cancelled'
                        ? game.cancellationReason === 'withdrawal'
                          ? `Canceled — ${game.withdrawnByTeamName ?? 'A team'} withdrew`
                          : 'Canceled'
                        : game.status}
                      {game.homeScore == null || game.awayScore == null
                        ? ''
                        : ` · ${game.awayScore}–${game.homeScore}`}
                    </Text>
                  )}
                </Card>
              )
            })
          )}
          {props.scheduleActions}
        </View>
      )}
      {mayView && tab === 'stats' && (
        <View style={styles.section}>
          {statsLoading && (
            <Text style={styles.muted}>Loading statistics…</Text>
          )}
          {statsError !== '' && (
            <View style={styles.section}>
              <Text accessibilityRole="alert" style={styles.error}>
                {statsError}
              </Text>
              <Button
                label="Retry stats"
                accessibilityLabel="Retry stats"
                kind="secondary"
                onPress={() => {
                  setStatsRetry(value => value + 1)
                }}
              />
            </View>
          )}
          {!statsLoading && statsError === '' && (
            <>
              <SectionHeader
                title="Batting"
                note={`${batting.length} players`}
              />
              {batting.length === 0 ? (
                <Card>
                  <Text style={styles.muted}>No batting statistics yet.</Text>
                </Card>
              ) : (
                <Card flush>
                  <StatisticsTable
                    rows={batting}
                    columns={battingColumns}
                    onOpen={openPlayer}
                  />
                </Card>
              )}
              <SectionHeader
                title="Pitching"
                note={`${pitching.length} players`}
              />
              {pitching.length === 0 ? (
                <Card>
                  <Text style={styles.muted}>No pitching statistics yet.</Text>
                </Card>
              ) : (
                <Card flush>
                  <StatisticsTable
                    rows={pitching}
                    columns={pitchingColumns}
                    onOpen={openPlayer}
                  />
                </Card>
              )}
            </>
          )}
        </View>
      )}
      {mayView && tab === 'videos' && !loading && (
        <View style={styles.section}>
          <SectionHeader
            title="Game videos"
            note={gameCountLabel(withVideo.length)}
          />
          {withVideo.length === 0 ? (
            <Card>
              <Text style={styles.muted}>No recorded games here yet.</Text>
            </Card>
          ) : (
            <View style={styles.videoGrid}>
              {withVideo.map(game => {
                const lines = matchupLines(game)
                return (
                  <View
                    key={game.id}
                    style={{
                      width: `${100 / columnsForWidth(width)}%`,
                      padding: theme.rem(0.25)
                    }}
                  >
                    <Card>
                      <GameRow
                        first={lines.first}
                        second={lines.second}
                        detail={`${shortDate(game.startAt)}${game.startAt == null ? '' : ` · ${shortTime(game.startAt)}`} · ${videoCountLabel(game.videoCount)}`}
                        length={
                          game.durationSec == null
                            ? undefined
                            : clock(game.durationSec)
                        }
                        venue={game.venue}
                        posterUrl={game.posterUrl ?? undefined}
                        badgeLabel={
                          game.pendingApproval ? 'Pending approval' : undefined
                        }
                        onPress={() => {
                          onOpenGame(
                            game.id,
                            `${lines.first} ${lines.second}`,
                            { autoPlay: true }
                          )
                        }}
                      />
                    </Card>
                  </View>
                )
              })}
            </View>
          )}
        </View>
      )}
      {tab === 'teams' && !loading && (
        <View style={styles.section}>
          {breaker.error !== '' && (
            <Text accessibilityRole="alert" style={styles.error}>
              {breaker.error}
            </Text>
          )}
          {mayView ? (
            <>
              {(teamActions != null ||
                teams.length === 0 ||
                teams.some(
                  team => (team.seasonCategory ?? 'unscheduled') === 'inSeason'
                )) && (
                <SectionHeader
                  title="Teams"
                  note={String(
                    teams.filter(
                      team =>
                        (team.seasonCategory ?? 'unscheduled') === 'inSeason'
                    ).length
                  )}
                  actions={teamActions}
                />
              )}
              {teams.length === 0 && (
                <Card>
                  <Text style={styles.muted}>No teams in this season yet.</Text>
                </Card>
              )}
              {categories.map(category => {
                const list = teams.filter(
                  team => (team.seasonCategory ?? 'unscheduled') === category.id
                )
                return list.length === 0 ? null : (
                  <View key={category.id} style={styles.section}>
                    {category.id !== 'inSeason' && (
                      <SectionHeader
                        title={category.title}
                        note={String(list.length)}
                      />
                    )}
                    {category.id === 'unscheduled' && (
                      <Text style={styles.muted}>
                        These teams are in the season but don&apos;t have
                        scheduled games.
                      </Text>
                    )}
                    {teamCards(list)}
                  </View>
                )
              })}
            </>
          ) : (
            <>
              <SectionHeader
                title="Teams"
                note={String(publicTeams.length)}
                actions={teamActions}
              />
              {teamCards(
                publicTeams.map(team => ({
                  id: team.id,
                  name: team.name,
                  shortName: null,
                  logoPath: null,
                  logoUrl: team.imageUrl,
                  canViewPrivate: false,
                  record: null,
                  kind: team.external ? 'external' : 'full',
                  seasonCategory: 'unscheduled'
                }))
              )}
            </>
          )}
        </View>
      )}
      {tab === 'people' && seesPeople && (
        <LevelPeopleTab
          client={client}
          kind="season"
          id={season.id}
          onOpenPlayer={props.onOpenPlayer}
          onOpenPerson={props.onOpenPerson}
        />
      )}
      {breaker.sheet}
      {choosing === 'add' && management != null && (
        <ChoiceSheet
          title="Add a team"
          choices={[
            {
              label: 'Team this season manages',
              detail: `${season.name} becomes the team's parent; its administrators manage the team.`,
              onPress: () => {
                management.onAddTeam('parent')
              }
            },
            {
              label: 'Team that competes',
              detail:
                'The team plays in this season and keeps its own management.',
              onPress: () => {
                management.onAddTeam('participation')
              }
            }
          ]}
          onClose={() => {
            setChoosing(undefined)
          }}
        />
      )}
      {choosing === 'create' && management != null && (
        <ChoiceSheet
          title="Create"
          choices={[
            {
              label: 'Team',
              detail: `A team managed by ${season.name}.`,
              onPress: management.onCreateTeam
            },
            {
              label: 'Placeholder team',
              detail: `A stand-in for a team without its own administrator, kept by ${season.name}.`,
              onPress: () => {
                management.onCreatePlaceholder?.()
              }
            }
          ]}
          onClose={() => {
            setChoosing(undefined)
          }}
        />
      )}
    </StickySectionLayout>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  headerHandoff: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceXsRem)
  },
  headerName: {
    color: theme.headerTextColor,
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.0625),
    fontWeight: '700'
  },
  identity: { gap: theme.rem(theme.spaceMdRem) },
  identityTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.rem(theme.spaceSmRem)
  },
  seasonName: {
    flex: 1,
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.5),
    fontWeight: '700',
    color: theme.primaryTextColor
  },
  seasonMeta: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  section: { gap: theme.rem(theme.spaceMdRem) },
  publicGameHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.rem(theme.spaceSmRem)
  },
  publicGameMatchup: { flex: 1 },
  name: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  },
  muted: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.secondaryTextColor
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.dangerColor
  },
  gear: {
    width: theme.rem(2),
    height: theme.rem(2),
    borderRadius: theme.rem(1),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.containerBackgroundColor
  },
  videoGrid: { flexDirection: 'row', flexWrap: 'wrap' }
}))
