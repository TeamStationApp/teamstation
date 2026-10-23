import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type {
  MyRoles,
  PlayerDetail,
  PlayerHighlight,
  PlayerStats,
  PlayerTeam,
  RosterEntry,
  TeamStationClient
} from '../../common/api'
import { rosterFullName, shortName } from '../../common/names'
import { coachesTeam, keepsSongs, managesRoster } from '../../common/roles'
import type { WalkUpSong } from '../../common/walkUpSong'
import {
  Button,
  Card,
  CardBand,
  Emblem,
  GameRow,
  HandoffView,
  initialsOf,
  PillBand,
  PillTabs,
  PinnedContent,
  PinnedSpacer,
  Screen,
  SettingsGear,
  type StatFilter,
  StatFilterModal,
  StatGrid,
  useHeaderHandoff,
  usePinnedHandoff,
  usePinnedTabs
} from '../components'
import { TabPages } from '../components/TabPages'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import webMusic, { type WalkUpMusic } from '../walkup/walkUpMusic'
import { WalkUpTab } from '../walkup/WalkUpTab'
import { battingLine, exactDateTime } from './format'
import { GuardianInvite, GuardianRequest } from './PlayerGuardians'
import { PlayerRemoveFromTeam } from './PlayerRemoveFromTeam'
import { PlayerSettingsTab } from './PlayerSettingsTab'
import { PlayerTeamRoles } from './PlayerTeamRoles'
import { PlayerTeamsTab } from './PlayerTeamsTab'
import { battingColumns, pitchingColumns, playerStats } from './statColumns'

export interface PlayerScreenProps {
  client: TeamStationClient
  userId: string
  /** The name the row that was tapped showed, so the header has one at once. */
  title?: string
  /** Which tab to open on, from the address. */
  initialTab?: PlayerTab
  onTab?: (tab: PlayerTab, correcting?: boolean) => void
  /**
   * The team the page was opened for, the address's `onTeam`: the roster
   * row or the box-score side that was tapped. Both filters start on it, and
   * the Settings and Walk-up tabs edit the player on it. Without one the page
   * is the player's whole career, opened from Home. The filters never change
   * it.
   */
  forTeam?: string
  /**
   * The viewer's roles, from `GET /me/roles`, which decide whether Settings
   * and Walk-up are offered: Settings to a guardian of the player, or to
   * whoever manages the roster of `forTeam` — a coach, assistant,
   * scorekeeper or admin of it (`managesRoster`; of any team the player
   * plays on, without one); Walk-up beside `forTeam` to a guardian or a
   * keeper of its songs. Undefined while that is still being asked, so an
   * address that opens on either is not sent back to Videos before the
   * answer is in.
   */
  roles?: MyRoles
  /** After Settings saves the player on `forTeam`, their roster entry. */
  onSettingsSaved?: (entry: RosterEntry) => void
  /**
   * Who is signed in, if anybody. Somebody who is not the player and has no
   * say over them yet is offered "Request to be a guardian".
   */
  viewer?: { userId: string; isAdmin: boolean }
  /** The Walk-up tab. The song itself is read from `forTeam`'s roster. */
  walkUp?: {
    /** Finds the song on this phone, for Preview. */
    resolve?: (song: WalkUpSong) => Promise<string | null>
    /**
     * Opens the song picker, titled with the player's name: the loaded
     * player's, which an address opened from a link has no other way to know.
     */
    onPick?: (song: WalkUpSong | null, playerName: string) => void
    /** Whether Preview fades Apple Music on the phone's volume. */
    fadeAppleMusic?: boolean
  }
  /** The phone's music; the web's adapter, which has none, by default. */
  music?: WalkUpMusic
  /**
   * What the Stats tab opens narrowed to, from the address.
   *
   * A reader who tapped a name in a box score is asking about that season, not
   * about a career, so the game they came from sets this. With nothing set,
   * the tab opens on `forTeam`, or on a career without one.
   */
  initialFilter?: StatFilter
  /** So the address follows the filter, and a link can be sent. */
  onFilter?: (filter: StatFilter) => void
  /** What the Videos tab opens narrowed to, from the address, as above. */
  initialVideoFilter?: StatFilter
  /** So the address follows the Videos filter. */
  onVideoFilter?: (filter: StatFilter) => void
  /** A row of the Teams tab. */
  onOpenTeam?: (teamId: string, name: string) => void
  /**
   * The team's administrator took the player off `forTeam` from Settings:
   * back to that team's roster, saying so with `notice`.
   */
  onRemovedFromTeam?: (teamId: string, teamName: string, notice: string) => void
  /** Opens the game's video at the moment of one of their highlights. */
  onOpenMoment?: (
    gameId: string,
    videoId: string,
    atSec: number,
    title: string
  ) => void
}

export type PlayerTab = 'videos' | 'stats' | 'teams' | 'settings' | 'walkup'

const TABS: Array<{ id: PlayerTab; label: string }> = [
  { id: 'videos', label: lstrings.player_videos },
  { id: 'stats', label: lstrings.player_stats }
]
const WALKUP_TAB = {
  id: 'walkup' as const,
  label: lstrings.player_walkup
}
const TEAMS_TAB = {
  id: 'teams' as const,
  label: lstrings.player_teams
}

/**
 * One player: their face, their name, how they bat and throw, and then what
 * they have actually done.
 *
 * Shaped like a team's page, deliberately — an identity card and a strip of
 * tabs — because they are the same kind of thing and a reader who has learned
 * one has learned the other. The photograph is a circle rather than the team's
 * rounded badge: a face is a circle everywhere else in this app already.
 *
 * The title is the short name, for everybody. The whole name sits under it
 * only when the server sent one, which it does for a coach or an
 * administrator of the player's team, a parent, the player and a site
 * administrator; this screen never decides that for itself.
 */
export function PlayerScreen(props: PlayerScreenProps): React.ReactElement {
  const {
    client,
    userId,
    title,
    initialTab,
    initialFilter,
    initialVideoFilter,
    onTab,
    onFilter,
    onVideoFilter,
    onOpenMoment,
    onOpenTeam,
    onRemovedFromTeam,
    forTeam,
    roles,
    viewer,
    walkUp,
    music = webMusic
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)

  const savedPlayer = useRef<
    { userId: string; entry: RosterEntry; profileName: string } | undefined
  >(undefined)
  // Whether the viewer manages `forTeam`'s roster, and so may read the
  // player's whole name from it: undefined while their roles are asked.
  const rosterManager =
    forTeam == null
      ? false
      : roles == null
        ? undefined
        : managesRoster(roles, forTeam)
  const [privateName, setPrivateName] = useState<string>()
  const [privateNameDenied, setPrivateNameDenied] = useState(false)
  const privateNameGeneration = useRef(0)
  useEffect(() => {
    let live = true
    const generation = ++privateNameGeneration.current
    setPrivateName(undefined)
    setPrivateNameDenied(false)
    if (rosterManager === true && forTeam != null) {
      client
        .roster(forTeam, { includeFullNames: true })
        .then(rows => {
          if (!live || privateNameGeneration.current !== generation) return
          const entry = rows.find(
            row => String(row.userId) === userId && row.isPlayer
          )
          if (entry == null) setPrivateNameDenied(true)
          setPrivateName(
            entry?.nameDetails == null
              ? undefined
              : rosterFullName({ id: entry.userId, ...entry.nameDetails })
          )
        })
        .catch(() => {
          if (live && privateNameGeneration.current === generation) {
            setPrivateName(undefined)
            setPrivateNameDenied(true)
          }
        })
    }
    return () => {
      live = false
    }
  }, [client, userId, forTeam, rosterManager])
  const [tab, setTab] = useState<PlayerTab>(initialTab ?? 'videos')
  /**
   * The address is allowed to change this, not only to start it.
   *
   * Seeded once, the two disagreed the moment anything but a tap moved the
   * address: Back from the box score wrote `/games/g1` and left the box score
   * on the screen — on a phone, where Back is how people leave things, a
   * button that does nothing reads as a hang. Both ends of the app gain the
   * same thing, because it is the same code.
   *
   * The default is repeated rather than guarded against: an address that names
   * no half means the first one.
   */
  useEffect(() => {
    setTab(initialTab ?? 'videos')
  }, [initialTab])

  const [player, setPlayer] = useState<PlayerDetail | undefined>(undefined)

  // Settings is offered to a guardian of the player, and to whoever manages
  // the roster of the team the page was opened for (of any team the player
  // plays on now, opened from anywhere else: not one they have left, as the
  // server decides it); Walk-up, beside a team, to a guardian or a keeper of
  // its songs. On the web and on a phone alike, and to nobody else. An
  // address that asks for either without that right opens on Videos, and
  // says so, once the answer to "do they hold it?" is in; until then an
  // address that asks for Settings shows it loading.
  // `guardianOf` names each child by the row they sign in as, which is the
  // loaded player's; an address made before a merge names a closed row, so
  // the route's id stands in only until the player is in.
  const guardian =
    roles == null
      ? undefined
      : roles.guardianOf.includes(player?.userId ?? userId)
  const canManage =
    roles == null
      ? undefined
      : guardian === true ||
        (forTeam != null
          ? managesRoster(roles, forTeam)
          : player == null
            ? undefined
            : player.teams.some(
                team => team.current && managesRoster(roles, team.teamId)
              ))
  const canKeepSongs =
    forTeam == null
      ? false
      : roles == null
        ? undefined
        : guardian === true || keepsSongs(roles, forTeam)
  const settingsShown = canManage === true
  const settingsPending = canManage == null && tab === 'settings'
  // Who may invite a guardian is the server's to say, since it turns on
  // whether the player has one yet: a guardian invites another from Settings
  // wherever it opens, in their own name; a team's admin, coach or assistant
  // invites from that team's Settings, only while the player has none.
  const inviteAs = player?.guardianInviteAs ?? null
  const invitesGuardians =
    inviteAs === 'guardian' ||
    (inviteAs === 'team' && forTeam != null && coachesTeam(roles, forTeam))
  // Anybody else signed in who can see the player — not the player,
  // not a guardian, and with no say over them on any team they play on now
  // (a coach of one they left has none) — may ask to be one, once the player
  // and the viewer's roles are both known.
  const asksToGuard =
    viewer != null &&
    !viewer.isAdmin &&
    roles != null &&
    player != null &&
    guardian === false &&
    viewer.userId !== player.userId &&
    viewer.userId !== userId &&
    !coachesTeam(roles, forTeam) &&
    !player.teams.some(team => team.current && coachesTeam(roles, team.teamId))
  const walkUpShown = canKeepSongs === true
  // Taking the player off `forTeam` is for its administrators (an owner's or
  // manager's membership counts, as `GET /me/roles` says) and a site
  // administrator, whether or not the player can sign in; the server decides
  // again. Named once the player is in, and only while they play on it now:
  // a team they have left has nobody to take off.
  const removesFromTeam =
    forTeam != null &&
    (viewer?.isAdmin === true ||
      (roles?.teams[forTeam] ?? []).includes('admin'))
  const teamName = player?.teams.find(
    team => team.teamId === forTeam && team.current
  )?.teamName
  const tabs = [...TABS, ...(walkUpShown ? [WALKUP_TAB] : []), TEAMS_TAB]
  const refused =
    (tab === 'settings' && canManage === false) ||
    (tab === 'walkup' && canKeepSongs === false)
  useEffect(() => {
    if (!refused) return
    setTab('videos')
    onTab?.('videos', true)
  }, [refused, onTab])
  const shownTab =
    (tab === 'settings' && !settingsShown && !settingsPending) ||
    (tab === 'walkup' && !walkUpShown)
      ? 'videos'
      : tab

  const [error, setError] = useState<string | undefined>(undefined)
  const [highlights, setHighlights] = useState<PlayerHighlight[]>([])
  const [nextBefore, setNextBefore] = useState<string | undefined>(undefined)
  const [withoutVideo, setWithoutVideo] = useState(0)
  const [loadingVideos, setLoadingVideos] = useState(true)
  /** The page being asked for. Undefined is the first one. */
  const [before, setBefore] = useState<string | undefined>(undefined)
  const [stats, setStats] = useState<PlayerStats | undefined>(undefined)
  // Each tab keeps a filter of its own, starting from what the address or
  // the tap asked for, else the team the page was opened for, else a career.
  const [filter, setFilter] = useState<StatFilter>(() =>
    startingFilter(initialFilter, forTeam)
  )
  const [videoFilter, setVideoFilter] = useState<StatFilter>(() =>
    startingFilter(initialVideoFilter, forTeam)
  )
  const narrowed = isNarrowed(filter)
  /** Which tab's filter the sheet is open for. */
  const [filtering, setFiltering] = useState<'stats' | 'videos' | undefined>(
    undefined
  )
  const [loadingStats, setLoadingStats] = useState(true)

  // The name slides up into the header as the card goes under it, the way a
  // team's does. Until the request lands, the name the tapped row showed is
  // what goes up there: it is the same name, and a header that appears half a
  // second late reads as the page having jumped.
  const publicName =
    savedPlayer.current?.userId === userId
      ? savedPlayer.current.profileName
      : player?.name
  const shown =
    tab === 'settings' && rosterManager === true && !privateNameDenied
      ? (privateName ?? publicName ?? title ?? '')
      : (publicName ?? (privateNameDenied ? '' : title) ?? '')
  // What a guardian invitation or request, or taking them off the team,
  // names the player by: the short name, even where a roster manager's header
  // shows the whole one.
  const shortShown = publicName ?? (privateNameDenied ? '' : title) ?? ''
  const head = usePinnedHandoff()
  const { handoff } = head
  const progress = handoff.progress
  const avatarUrl = player?.avatarUrl
  useHeaderHandoff(
    useMemo(
      () => (
        <HandoffView progress={progress} style={styles.headerHandoff}>
          <Emblem
            uri={avatarUrl}
            fallback={initialsOf(shown)}
            shape="circle"
            size={1.75}
          />
          <Text style={styles.headerName} numberOfLines={1}>
            {shown}
          </Text>
        </HandoffView>
      ),
      [progress, styles.headerHandoff, styles.headerName, avatarUrl, shown]
    )
  )

  // A screen re-used for a second player must not keep the first one's pages,
  // or the first one's filter: a season the new player never played in is not
  // a narrowing anybody asked for. The stack unmounts between two players
  // today, so this has nothing to undo — and a list that silently appended
  // somebody else's highlights would be very hard to see and impossible to
  // explain.
  //
  // On the first render there is nothing to forget, and clearing then would
  // throw away the filter the address arrived with.
  const showing = useRef(userId)
  useEffect(() => {
    if (showing.current === userId) return
    showing.current = userId
    setPlayer(undefined)
    setHighlights([])
    setNextBefore(undefined)
    setWithoutVideo(0)
    setBefore(undefined)
    setStats(undefined)
    setError(undefined)
    setFilter(startingFilter(undefined, forTeam))
    setVideoFilter(startingFilter(undefined, forTeam))
  }, [userId, forTeam])

  useEffect(() => {
    let cancelled = false
    client
      .player(userId)
      .then(loaded => {
        if (!cancelled) {
          const saved = savedPlayer.current
          setPlayer(
            saved?.userId === userId
              ? {
                  ...loaded,
                  name: saved.profileName,
                  bats: saved.entry.bats,
                  throws: saved.entry.throws
                }
              : loaded
          )
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(
            caught instanceof Error
              ? caught.message
              : lstrings.player_cannot_load
          )
        }
      })
    return () => {
      cancelled = true
    }
  }, [client, userId])

  // Their highlights, a page at a time: every play they are credited on in
  // the games the Videos filter is on. A new filter starts again from the
  // first page, which `before` is set back to alongside it.
  useEffect(() => {
    let cancelled = false
    setLoadingVideos(true)
    client
      .playerHighlights(userId, { before, ...videoFilter })
      .then(page => {
        if (cancelled) return
        // Appended rather than replaced: `Show more` is another page of the
        // same list, not a new one.
        setHighlights(held =>
          before == null ? page.highlights : [...held, ...page.highlights]
        )
        setNextBefore(page.nextBefore ?? undefined)
        setWithoutVideo(held => (before == null ? 0 : held) + page.withoutVideo)
      })
      .catch(() => {
        // The hero card and the stats are still worth showing without them.
        if (!cancelled) setNextBefore(undefined)
      })
      .finally(() => {
        if (!cancelled) setLoadingVideos(false)
      })
    return () => {
      cancelled = true
    }
  }, [client, userId, before, videoFilter])

  // Their figures, for whichever games the filter is on. Asked for again when
  // the filter changes rather than added up here: the arithmetic has one home,
  // and it is the one that was measured against published box scores.
  useEffect(() => {
    let cancelled = false
    setLoadingStats(true)
    client
      .playerStats(userId, filter)
      .then(loaded => {
        if (!cancelled) setStats(loaded)
      })
      .catch(() => {
        if (!cancelled) setStats(undefined)
      })
      .finally(() => {
        if (!cancelled) setLoadingStats(false)
      })
    return () => {
      cancelled = true
    }
  }, [client, userId, filter])

  const handedness = player == null ? undefined : battingLine(player)
  const applyVideoFilter = (next: StatFilter): void => {
    setVideoFilter(next)
    setBefore(undefined)
    onVideoFilter?.(next)
  }

  // The card scrolls away and the pills pin under the header, as a team's
  // do; a selected tab starts directly under them. Every tab starts at its
  // top, so nothing waits on data: the card and the tab are measured again
  // as what loads changes their height.
  const { pinned, selectTab } = usePinnedTabs({
    head,
    ready: true,
    tab: shownTab,
    anchorOnRow: false
  })

  return (
    <Screen {...pinned.screen}>
      <CardBand part={pinned.cardBand}>
        <Card style={styles.identity}>
          <View style={styles.identityTop}>
            <Emblem
              uri={player?.avatarUrl}
              fallback={initialsOf(shown)}
              shape="circle"
              size={3.5}
            />
            <View style={styles.identityText}>
              <Text style={styles.playerName}>{shown}</Text>
              {/*
                Only when there is something to say. `B: —` claims we looked and
                found nothing; a missing line claims nothing at all, which is
                what an empty column actually means.
              */}
              {handedness != null && (
                <Text style={styles.playerMeta}>{handedness}</Text>
              )}
              {asksToGuard && (
                <GuardianRequest
                  client={client}
                  playerUserId={player.userId}
                  playerName={shortShown}
                  viewerId={viewer.userId}
                />
              )}
            </View>
            {settingsShown && (
              <SettingsGear
                label="Player settings"
                onPress={() => {
                  selectTab('settings')
                  setTab('settings')
                  onTab?.('settings')
                }}
              />
            )}
          </View>
        </Card>
      </CardBand>

      <PillBand part={pinned.pillBand}>
        <PillTabs
          tabs={tabs}
          selected={shownTab}
          onSelect={next => {
            selectTab(next)
            setTab(next)
            onTab?.(next)
          }}
          size="compact"
          dense={tabs.length >= 5}
          accessibilityLabel={lstrings.player_sections}
        />
      </PillBand>

      {error != null && <Text style={styles.error}>{error}</Text>}

      <TabPages
        page={shownTab}
        index={tabs.findIndex(item => item.id === shownTab)}
      >
        <PinnedContent
          key={shownTab}
          part={pinned.content}
          testID="playerTabContent"
        >
          {shownTab === 'videos' && (
            <View style={styles.section}>
              <View style={styles.pillRow}>
                <Button
                  label={
                    stats == null && player == null
                      ? lstrings.player_filter
                      : filterName(stats, videoFilter, player?.teams)
                  }
                  accessibilityLabel={lstrings.player_videos_filter}
                  icon="filter_alt"
                  kind="secondary"
                  compact
                  onPress={() => {
                    setFiltering('videos')
                  }}
                />
              </View>
              {loadingVideos && highlights.length === 0 && (
                <Card>
                  <Text style={styles.muted}>{lstrings.player_loading}</Text>
                </Card>
              )}
              {!loadingVideos && highlights.length === 0 && (
                <Card>
                  <Text style={styles.muted}>
                    {withoutVideo > 0
                      ? lstrings.player_videos_none_recorded
                      : isNarrowed(videoFilter)
                        ? lstrings.player_videos_filter_empty
                        : lstrings.player_videos_empty}
                  </Text>
                  {isNarrowed(videoFilter) && (
                    <Button
                      label={lstrings.player_filter_clear}
                      kind="secondary"
                      onPress={() => {
                        applyVideoFilter({})
                      }}
                    />
                  )}
                </Card>
              )}
              {highlights.map(highlight => (
                <Card key={`${highlight.eventId} ${highlight.videoId}`}>
                  <GameRow
                    first={highlight.teamName ?? ''}
                    second={highlight.outcome}
                    detail={exactDateTime(highlight.playAt)}
                    posterUrl={highlight.stillUrl}
                    onPress={() => {
                      onOpenMoment?.(
                        highlight.gameId,
                        highlight.videoId,
                        highlight.startOffsetSec,
                        highlight.outcome
                      )
                    }}
                  />
                </Card>
              ))}
              {nextBefore != null && (
                <Button
                  label={lstrings.player_show_more}
                  kind="secondary"
                  onPress={() => {
                    setBefore(nextBefore)
                  }}
                />
              )}
            </View>
          )}

          {shownTab === 'walkup' && forTeam != null && (
            <View style={styles.section}>
              <WalkUpTab
                client={client}
                teamId={forTeam}
                userId={userId}
                music={music}
                resolve={walkUp?.resolve}
                onPick={
                  walkUp?.onPick == null
                    ? undefined
                    : song => {
                        walkUp.onPick?.(song, shown)
                      }
                }
                fadeAppleMusic={walkUp?.fadeAppleMusic}
              />
            </View>
          )}

          {shownTab === 'teams' && (
            <View style={styles.section}>
              <PlayerTeamsTab teams={player?.teams} onOpenTeam={onOpenTeam} />
            </View>
          )}

          {shownTab === 'settings' && (
            <View style={styles.section}>
              {settingsPending ? (
                <Text style={styles.muted}>{lstrings.common_loading}</Text>
              ) : (
                <PlayerSettingsTab
                  client={client}
                  teamId={forTeam}
                  userId={userId}
                  fullNames={rosterManager === true}
                  onSaved={(hands, entry) => {
                    if (entry == null) {
                      // How they bat and throw is on the card above; keep it true.
                      setPlayer(held =>
                        held == null
                          ? held
                          : { ...held, bats: hands.bats, throws: hands.throws }
                      )
                      return
                    }
                    // A roster may extend surnames to resolve collisions. The
                    // ordinary player page always uses its own abbreviated name.
                    const profileName =
                      entry.nameDetails == null
                        ? entry.shortName
                        : shortName({ id: entry.userId, ...entry.nameDetails })
                    savedPlayer.current = { userId, entry, profileName }
                    props.onSettingsSaved?.(entry)
                    if (entry.nameDetails != null) {
                      privateNameGeneration.current++
                      setPrivateNameDenied(false)
                      setPrivateName(
                        rosterFullName({
                          id: entry.userId,
                          ...entry.nameDetails
                        })
                      )
                    }
                    // How they bat and throw is on the card above; keep it true.
                    setPlayer(held =>
                      held == null
                        ? held
                        : {
                            ...held,
                            name: profileName,
                            bats: entry.bats,
                            throws: entry.throws
                          }
                    )
                  }}
                />
              )}
              {!settingsPending && invitesGuardians && (
                <GuardianInvite
                  client={client}
                  teamId={inviteAs === 'team' ? forTeam : undefined}
                  playerUserId={player?.userId ?? userId}
                  playerName={shortShown}
                />
              )}
              {
                // The player's own roles on the team, for its staff.
                forTeam != null && coachesTeam(roles, forTeam) && (
                  <PlayerTeamRoles
                    client={client}
                    teamId={forTeam}
                    userId={player?.userId ?? userId}
                  />
                )
              }
              {
                // Last: taking them off the team, for its administrators alone.
                forTeam != null && removesFromTeam && teamName != null && (
                  <PlayerRemoveFromTeam
                    client={client}
                    teamId={forTeam}
                    teamName={teamName}
                    userId={player?.userId ?? userId}
                    shortName={shortShown}
                    onRemoved={notice => {
                      onRemovedFromTeam?.(forTeam, teamName, notice)
                    }}
                  />
                )
              }
            </View>
          )}

          {shownTab === 'stats' && (
            <View style={styles.section}>
              <View style={styles.filterRow}>
                <Text style={styles.scope}>
                  {scopeOf(stats, filter, player?.teams)}
                </Text>
                <Button
                  label={filterName(stats, filter, player?.teams)}
                  accessibilityLabel="Filter stats"
                  icon="filter_alt"
                  kind="secondary"
                  compact
                  onPress={() => {
                    setFiltering('stats')
                  }}
                />
              </View>

              {loadingStats && stats == null && (
                <Card>
                  <Text style={styles.muted}>{lstrings.player_loading}</Text>
                </Card>
              )}

              {stats != null &&
                stats.batting == null &&
                stats.pitching == null && (
                  <Card>
                    {/*
                    Two different silences. "Nothing under this filter" is a
                    narrowing the reader chose and can undo; "no stats yet" is
                    about the player. Saying the second when the first is true
                    reads as a boy with twelve games having none.
                  */}
                    <Text style={styles.muted}>
                      {narrowed
                        ? lstrings.player_filter_empty
                        : lstrings.player_stats_empty}
                    </Text>
                    {narrowed && (
                      <Button
                        label={lstrings.player_filter_clear}
                        kind="secondary"
                        onPress={() => {
                          setFilter({})
                          onFilter?.({})
                        }}
                      />
                    )}
                  </Card>
                )}

              {stats?.batting != null && (
                <Card>
                  <Text style={styles.cardTitle}>
                    {lstrings.player_batting}
                  </Text>
                  <StatGrid
                    stats={playerStats(stats.batting, battingColumns)}
                    columns={4}
                  />
                </Card>
              )}

              {/*
              A card that says why it is empty, rather than one that is not
              there: a pitcher with no plate appearances and a pitcher we have
              no figures for look identical when the card is simply dropped.
            */}
              {stats?.batting == null && stats?.pitching != null && (
                <Card>
                  <Text style={styles.cardTitle}>
                    {lstrings.player_batting}
                  </Text>
                  <Text style={styles.muted}>{lstrings.player_no_batting}</Text>
                </Card>
              )}

              {stats?.pitching != null && (
                <Card>
                  <Text style={styles.cardTitle}>
                    {lstrings.player_pitching}
                  </Text>
                  <StatGrid
                    stats={playerStats(stats.pitching, pitchingColumns)}
                    columns={4}
                  />
                </Card>
              )}
            </View>
          )}
        </PinnedContent>
      </TabPages>
      <PinnedSpacer part={pinned.spacer} />

      {filtering != null && stats != null && (
        <StatFilterModal
          options={stats.options}
          filter={filtering === 'videos' ? videoFilter : filter}
          onApply={next => {
            setFiltering(undefined)
            if (filtering === 'videos') {
              applyVideoFilter(next)
              return
            }
            setFilter(next)
            onFilter?.(next)
          }}
          onClose={() => {
            setFiltering(undefined)
          }}
        />
      )}
    </Screen>
  )
}

/**
 * Where a tab's filter starts: what the address or the tap asked for wins;
 * otherwise the team the page was opened for; otherwise a career.
 */
function startingFilter(
  asked: StatFilter | undefined,
  forTeam: string | undefined
): StatFilter {
  if (asked != null && isNarrowed(asked)) return asked
  return forTeam == null ? {} : { teamId: forTeam }
}

function isNarrowed(filter: StatFilter): boolean {
  return filter.seasonId != null || filter.teamId != null || filter.year != null
}

/** `12 games · Spring 2026`, or just the games for a career. */
function scopeOf(
  stats: PlayerStats | undefined,
  filter: StatFilter,
  teams?: PlayerTeam[]
): string {
  const named = filterName(stats, filter, teams)
  if (stats == null) return named
  const games =
    stats.games === 1
      ? lstrings.player_one_game
      : sprintf(lstrings.player_games, String(stats.games))
  return sprintf(lstrings.player_stats_scope, games, named)
}

/**
 * `Spring 2026`, `Hawks`, `2025`, or `Career`. A team or season the player
 * has no figures for yet is named from their teams instead.
 */
function filterName(
  stats: PlayerStats | undefined,
  filter: StatFilter,
  teams: PlayerTeam[] = []
): string {
  // A season renamed or re-imported since the link was sent is a filter with
  // no name left. Saying so beats `12 games · ` with nothing after it.
  return filter.seasonId != null
    ? (stats?.options.seasons.find(
        season => season.seasonId === filter.seasonId
      )?.name ??
        teams.find(team => team.seasonId === filter.seasonId)?.seasonName ??
        lstrings.player_filter_unknown)
    : filter.teamId != null
      ? (stats?.options.teams.find(team => team.teamId === filter.teamId)
          ?.name ??
        teams.find(team => team.teamId === filter.teamId)?.teamName ??
        lstrings.player_filter_unknown)
      : filter.year != null
        ? String(filter.year)
        : lstrings.player_filter_career
}

const getStyles = cacheStyles((theme: Theme) => ({
  pillRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end'
  },
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.rem(theme.spaceSmRem)
  },
  scope: {
    flex: 1,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  cardTitle: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600',
    color: theme.primaryTextColor,
    marginBottom: theme.rem(theme.spaceSmRem)
  },
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
    alignItems: 'flex-start',
    gap: theme.rem(theme.spaceMdRem)
  },
  identityText: {
    flex: 1,
    gap: theme.rem(0.125)
  },
  playerName: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.5),
    fontWeight: '700',
    letterSpacing: theme.rem(-0.02),
    color: theme.primaryTextColor
  },
  playerMeta: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
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
