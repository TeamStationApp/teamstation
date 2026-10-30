import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { ActivityIndicator, Text, View } from 'react-native'

import type {
  BattingRow,
  GamesPageQuery,
  ListCounts,
  Page,
  PitchingRow,
  SeasonGame,
  SeasonSummary,
  StandingsRow,
  TeamStationClient,
  TeamSummary
} from '../../common/api'
import type { GroupRef } from '../../common/groupCreation'
import { localityLabel } from '../../common/locality'
import type { GroupDetail, PublicGame } from '../../common/publicGroups'
import { seasonPeriodLabel } from '../../common/seasonTimeFrames'
import { type ChatLink, ChatLinks } from '../chat/ChatLinks'
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
import { PagedList } from '../components/PagedList'
import { PagedListEnd } from '../components/PagedListEnd'
import { useSceneReveals } from '../components/sceneShown'
import { SegmentedPill } from '../components/SegmentedPill'
import { StatisticsTable } from '../components/StatisticsTable'
import { StickySectionLayout } from '../components/StickySectionLayout'
import { TabPages } from '../components/TabPages'
import { type PagedRows, usePagedList } from '../hooks/usePagedList'
import { useStableCallback } from '../hooks/useStableCallback'
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
import { countFor, type When } from './whenFilter'

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
  chats?: ChatLink[]
  onOpenChat?: (chat: ChatLink) => void
  onLoadChatPreview?: (ids: string[]) => void
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

type TabId =
  'standings' | 'schedule' | 'stats' | 'videos' | 'teams' | 'chats' | 'people'
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

/** A list of the season's: one of the Schedule's pills, or Videos. */
type ListId = When | 'videos'

/** Each list's own filter, nearest to now first in both directions. */
const LIST_QUERY: Record<ListId, GamesPageQuery> = {
  past: { when: 'past', order: 'desc' },
  upcoming: { when: 'upcoming', order: 'asc' },
  all: { order: 'desc' },
  videos: { hasVideo: true, order: 'desc' }
}

/** A row's height before it has been measured, as each list draws them. */
const ROW_HEIGHT = { schedule: 140, public: 150, videos: 130 }

const gameId = (game: { id: string }): string => game.id

/** One of the season's lists, read by `read` when the screen asks. */
function useSeasonList<T extends { id: string }>(
  listKey: string,
  id: ListId,
  read: (query: GamesPageQuery) => Promise<Page<T>>
): PagedRows<T> {
  return usePagedList<T>({
    listKey: `${listKey}:${id}`,
    auto: false,
    keyOf: gameId,
    read: async cursor =>
      await read({ ...LIST_QUERY[id], ...(cursor == null ? {} : { cursor }) })
  })
}

function useSeasonLists<T extends { id: string }>(
  listKey: string,
  read: (query: GamesPageQuery) => Promise<Page<T>>
): Record<ListId, PagedRows<T>> {
  return {
    past: useSeasonList(listKey, 'past', read),
    upcoming: useSeasonList(listKey, 'upcoming', read),
    all: useSeasonList(listKey, 'all', read),
    videos: useSeasonList(listKey, 'videos', read)
  }
}

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
    { id: 'chats' as const, label: 'Chats' },
    ...(seesPeople ? [PEOPLE_TAB] : [])
  ]
  const defaultTab = mayView ? 'standings' : 'schedule'
  const allowedTab = (id?: string): TabId =>
    tabs.some(item => item.id === id) ? (id as TabId) : defaultTab
  const [tab, setTab] = useState<TabId>(allowedTab(initialTab))
  const [when, setWhen] = useState<When>(initialWhen ?? 'past')
  const [includeExhibitions, setIncludeExhibitions] = useState(false)
  const memberLists = useSeasonLists<SeasonGame>(
    `member:${season.id}`,
    async query => await client.seasonGamesPage(season.id, query)
  )
  const publicLists = useSeasonLists<PublicGame>(
    `public:${season.id}`,
    async query => await client.publicGamesPage('season', season.id, query)
  )
  // The latest handler under one identity, so the schedule's cards, kept
  // built across pill changes, are not drawn again for a new one.
  const openGame = useStableCallback(onOpenGame)
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

  // The season's Settings, pushed over this page, changes what it shows.
  const reveals = useSceneReveals()
  // The list on show is read the first time it is, and again each time the
  // season is: a pill chosen after that reads as it arrives, and until then
  // keeps what it holds.
  const listId: ListId = mayView && tab === 'videos' ? 'videos' : when
  const shownList = mayView ? memberLists[listId] : publicLists[listId]
  const { refresh: readList } = shownList
  const readTurn = useMemo(
    () => ({
      client,
      mayView,
      publicDetail,
      reveals,
      id: season.id,
      seasonRetry
    }),
    [client, mayView, publicDetail, reveals, season.id, seasonRetry]
  )
  const read = useRef(new Map<ListId, object>())
  useEffect(() => {
    if (read.current.get(listId) === readTurn) return
    read.current.set(listId, readTurn)
    readList().catch(() => undefined)
  }, [listId, readList, readTurn])

  useEffect(() => {
    let active = true
    setError('')
    if (!mayView) {
      seasonLoaded.current = null
      standingsLoaded.current = null
      statsLoaded.current = null
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
    client
      .seasonTeams(season.id)
      .then(loadedTeams => {
        if (active) {
          seasonLoaded.current = { client, id: season.id }
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
  }, [client, mayView, publicDetail, reveals, season.id, seasonRetry])

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
    reveals,
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

  // Every list's are the season's, whichever of them has been read.
  const lists: Array<{ counts: ListCounts | null }> = Object.values(
    mayView ? memberLists : publicLists
  )
  const counts =
    shownList.counts ?? lists.find(list => list.counts != null)?.counts
  const listError =
    shownList.error == null
      ? ''
      : shownList.error instanceof Error
        ? shownList.error.message
        : 'Cannot load season'
  const shownError = error !== '' ? error : listError
  // The first of the season's games are in, however its pills go after that.
  const opening = loading || (mayView && counts == null && shownList.loading)
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
      pagedList
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
                  value: String(counts?.total ?? season.games)
                },
                {
                  label: 'Videos',
                  value: String(counts?.videos ?? season.videos)
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
      {shownError !== '' && (
        <View style={styles.section}>
          <Text accessibilityRole="alert" style={styles.error}>
            {shownError}
          </Text>
          <Button
            label="Retry season"
            accessibilityLabel="Retry season"
            kind="secondary"
            onPress={() => {
              setSeasonRetry(value => value + 1)
            }}
          />
        </View>
      )}
      {opening && <Text style={styles.muted}>Loading…</Text>}
      {/* Kept built: its schedule and standings run the length of a season. */}
      <TabPages keep page={tab} index={tabs.findIndex(item => item.id === tab)}>
        <View key={tab} style={styles.page}>
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
              <SectionHeader
                title="Standings"
                note={`${standings.length} teams`}
              />
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
          {tab === 'schedule' && !opening && (
            <View style={styles.section}>
              <PillTabs
                tabs={WHEN_TABS}
                selected={when}
                onSelect={chooseWhen}
                accessibilityLabel="Which games"
              />
              <TabPages
                keep
                page={when}
                index={WHEN_TABS.findIndex(item => item.id === when)}
              >
                <View key={when} style={styles.page}>
                  <SectionHeader
                    title="Schedule"
                    note={
                      counts == null
                        ? undefined
                        : gameCountLabel(countFor(counts, when))
                    }
                  />
                  {mayView ? (
                    <SeasonGames
                      list={memberLists[when]}
                      footer={props.scheduleActions}
                      onOpenGame={openGame}
                    />
                  ) : (
                    <PublicGames
                      list={publicLists[when]}
                      footer={props.scheduleActions}
                      onOpenGame={openGame}
                    />
                  )}
                </View>
              </TabPages>
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
                      <Text style={styles.muted}>
                        No batting statistics yet.
                      </Text>
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
                      <Text style={styles.muted}>
                        No pitching statistics yet.
                      </Text>
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
          {mayView && tab === 'videos' && !opening && (
            <View style={styles.section}>
              <SectionHeader
                title="Game videos"
                note={
                  counts == null ? undefined : gameCountLabel(counts.withVideo)
                }
              />
              <SeasonVideos
                list={memberLists.videos}
                columns={columnsForWidth(width)}
                onOpenGame={openGame}
              />
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
                      team =>
                        (team.seasonCategory ?? 'unscheduled') === 'inSeason'
                    )) && (
                    <SectionHeader
                      title="Teams"
                      note={String(
                        teams.filter(
                          team =>
                            (team.seasonCategory ?? 'unscheduled') ===
                            'inSeason'
                        ).length
                      )}
                      actions={teamActions}
                    />
                  )}
                  {teams.length === 0 && (
                    <Card>
                      <Text style={styles.muted}>
                        No teams in this season yet.
                      </Text>
                    </Card>
                  )}
                  {categories.map(category => {
                    const list = teams.filter(
                      team =>
                        (team.seasonCategory ?? 'unscheduled') === category.id
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
          {tab === 'chats' && (
            <ChatLinks
              chats={props.chats ?? []}
              onOpen={props.onOpenChat}
              onLoadPreview={props.onLoadChatPreview}
            />
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
        </View>
      </TabPages>
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

/** A spinner until a list's rows are in, and then what `none` says. */
function noRows(
  list: Pick<PagedRows<unknown>, 'loading' | 'empty'>,
  none: React.ReactElement | null
): React.ReactElement | null {
  if (list.loading)
    return <ActivityIndicator accessibilityLabel="Loading games" />
  return list.empty ? none : null
}

/** A pill's list of a season's games, for those who may see all of it. */
function SeasonGames(props: {
  list: PagedRows<SeasonGame>
  footer: React.ReactNode
  onOpenGame: SeasonPresentationProps['onOpenGame']
}): React.ReactElement {
  const { list, footer, onOpenGame } = props
  const { rows, loadMore } = list
  const styles = getStyles(useTheme())
  const renderRow = useCallback(
    (game: SeasonGame) => (
      <View style={styles.row}>
        <SeasonGameCard game={game} onOpenGame={onOpenGame} />
      </View>
    ),
    [onOpenGame, styles.row]
  )
  return (
    <PagedList
      data={rows}
      keyOf={gameId}
      renderItem={renderRow}
      estimatedItemSize={ROW_HEIGHT.schedule}
      empty={noRows(
        list,
        <Card>
          <Text style={styles.muted}>Nothing here yet.</Text>
        </Card>
      )}
      footer={
        <>
          <PagedListEnd list={list} />
          {footer}
        </>
      }
      onEndReached={() => {
        loadMore().catch(() => undefined)
      }}
    />
  )
}

/** A pill's list of a season's games, as the public reads them. */
function PublicGames(props: {
  list: PagedRows<PublicGame>
  footer: React.ReactNode
  onOpenGame: SeasonPresentationProps['onOpenGame']
}): React.ReactElement {
  const { list, footer, onOpenGame } = props
  const { rows, loadMore } = list
  const styles = getStyles(useTheme())
  const renderRow = useCallback(
    (game: PublicGame) => (
      <View style={styles.row}>
        <PublicGameCard game={game} onOpenGame={onOpenGame} />
      </View>
    ),
    [onOpenGame, styles.row]
  )
  return (
    <PagedList
      data={rows}
      keyOf={gameId}
      renderItem={renderRow}
      estimatedItemSize={ROW_HEIGHT.public}
      empty={noRows(list, null)}
      footer={
        <>
          <PagedListEnd list={list} />
          {footer}
        </>
      }
      onEndReached={() => {
        loadMore().catch(() => undefined)
      }}
    />
  )
}

/** The season's recorded games, a grid on a wide window, newest first. */
function SeasonVideos(props: {
  list: PagedRows<SeasonGame>
  columns: number
  onOpenGame: SeasonPresentationProps['onOpenGame']
}): React.ReactElement {
  const { list, columns, onOpenGame } = props
  const { rows, loadMore } = list
  const styles = getStyles(useTheme())
  const renderRow = useCallback(
    (game: SeasonGame) => (
      <View style={styles.videoCell}>
        <SeasonVideoCard game={game} onOpenGame={onOpenGame} />
      </View>
    ),
    [onOpenGame, styles.videoCell]
  )
  return (
    <PagedList
      data={rows}
      keyOf={gameId}
      renderItem={renderRow}
      numColumns={columns}
      estimatedItemSize={ROW_HEIGHT.videos}
      empty={noRows(
        list,
        <Card>
          <Text style={styles.muted}>No recorded games here yet.</Text>
        </Card>
      )}
      footer={<PagedListEnd list={list} />}
      onEndReached={() => {
        loadMore().catch(() => undefined)
      }}
    />
  )
}

const SeasonVideoCard = memo(function SeasonVideoCard(props: {
  game: SeasonGame
  onOpenGame: SeasonPresentationProps['onOpenGame']
}): React.ReactElement {
  const { game, onOpenGame } = props
  const lines = matchupLines(game)
  return (
    <Card>
      <GameRow
        first={lines.first}
        second={lines.second}
        detail={`${shortDate(game.startAt)}${game.startAt == null ? '' : ` · ${shortTime(game.startAt)}`} · ${videoCountLabel(game.videoCount)}`}
        length={game.durationSec == null ? undefined : clock(game.durationSec)}
        venue={game.venue}
        posterUrl={game.posterUrl ?? undefined}
        badgeLabel={game.pendingApproval ? 'Pending approval' : undefined}
        onPress={() => {
          onOpenGame(game.id, `${lines.first} ${lines.second}`, {
            autoPlay: true
          })
        }}
      />
    </Card>
  )
})

/** A game on the public schedule, with what a visitor may do with it. */
const PublicGameCard = memo(function PublicGameCard(props: {
  game: PublicGame
  onOpenGame: SeasonPresentationProps['onOpenGame']
}): React.ReactElement {
  const { game, onOpenGame } = props
  const styles = getStyles(useTheme())
  const options = gameListOptions(game, 'schedule')
  return (
    <Card>
      <View style={styles.publicGameHeader}>
        <Text style={[styles.name, styles.publicGameMatchup]}>
          {game.awayTeam.name} at {game.homeTeam.name}
        </Text>
        {game.isUmpire === true && game.status !== 'cancelled' && (
          <Badge label="UMP" tone="umpire" />
        )}
        {game.isGameLive === true && game.status !== 'cancelled' && (
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
        {shortTime(game.startAt) === '' ? '' : ` · ${shortTime(game.startAt)}`}
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

/**
 * A game on the season's schedule. Drawn again only when its game changes:
 * the schedule's pages are kept built across pill changes, and a season's
 * worth of rows drawn on every one would hold the next tap up.
 */
const SeasonGameCard = memo(function SeasonGameCard(props: {
  game: SeasonGame
  onOpenGame: SeasonPresentationProps['onOpenGame']
}): React.ReactElement {
  const { game, onOpenGame } = props
  const lines = matchupLines(game)
  const options = gameListOptions(game, 'schedule')
  return (
    <Card>
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
                onOpenGame(game.id, `${lines.first} ${lines.second}`, options)
              }
        }
      />
    </Card>
  )
})

const getStyles = cacheStyles((theme: Theme) => ({
  // One pill's sections, spaced as the screen spaces them.
  page: {
    gap: theme.rem(theme.spaceLgRem)
  },
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
  // A list's rows are placed one by one, so its gap is on each of them.
  row: { paddingBottom: theme.rem(theme.spaceLgRem) },
  videoCell: { padding: theme.rem(0.25) }
}))
