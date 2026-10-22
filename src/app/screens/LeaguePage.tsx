import React, { useEffect, useMemo, useState } from 'react'
import { Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { GroupKind, GroupRef } from '../../common/groupCreation'
import { localityLabel } from '../../common/locality'
import type { GroupDetail, PublicGroup } from '../../common/publicGroups'
import { seasonPeriodLabel } from '../../common/seasonTimeFrames'
import {
  Card,
  Emblem,
  HandoffView,
  initialsOf,
  PillTabs,
  SectionHeader,
  SettingsGear,
  useHandoff,
  useHeaderHandoff,
  useHeaderSlot
} from '../components'
import { ActionList } from '../components/ActionRow'
import { ChoiceSheet } from '../components/ChoiceSheet'
import { StickySectionLayout } from '../components/StickySectionLayout'
import {
  cacheStyles,
  ScopedThemeProvider,
  type Theme,
  useTheme
} from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
import { GroupRelationshipRow } from './GroupRelationshipRow'
import type { GroupLinkChoice } from './GroupScreen'
import { LevelPeopleTab } from './LevelPeopleTab'
import { useBreakParent } from './useBreakParent'

export interface LeaguePageProps {
  client: TeamStationClient
  detail: GroupDetail
  onOpen: (group: GroupRef) => void
  onCreate: (
    kind: GroupKind,
    parent: GroupRef,
    locality?: PublicGroup['locality']
  ) => void
  onSettings: (group: GroupRef) => void
  onLink: (choice: GroupLinkChoice) => void
  onCreateExternal?: (custodian: GroupRef) => void
  /** A player on the People tab, opened on their page. */
  onOpenPlayer?: (userId: string, name: string) => void
  /** Anybody else on the People tab, as their profile. */
  onOpenPerson?: (userId: string, name: string) => void
  /** Called after a relationship is broken, to load the page again. */
  onChanged: () => void
  initialTab?: string
  onTab?: (tab: string, correcting?: boolean) => void
}

type TabId = 'seasons' | 'teams' | 'people'

/**
 * A league: its seasons, its teams and its people, one tab each; the people
 * for its members and role holders.
 *
 * No schedule: a league outlives many seasons, and their games belong on the
 * season pages. Every season and team here is a child of the league, shown as
 * a card that opens it, with a ⋮ that breaks the link.
 */
export function LeaguePage(props: LeaguePageProps): React.ReactElement {
  const { client, detail, onOpen, onCreate, onLink, initialTab, onTab } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  // Some themes use a light card surface with light canvas text.
  const teamListTheme = useMemo(
    () =>
      theme.primaryTextColor === theme.cardBackgroundColor
        ? {
            ...theme,
            primaryTextColor: theme.secondaryTextColor,
            activeColor: theme.secondaryTextColor,
            dangerColor: tsBallpark.dangerColor
          }
        : theme,
    [theme]
  )
  const { group } = detail
  const league: GroupRef = { kind: 'league', id: group.id }
  const tabs = [
    { id: 'seasons' as const, label: 'Seasons' },
    { id: 'teams' as const, label: 'Teams' },
    // Its members and role holders read the league's people.
    ...(detail.canSeePeople === true
      ? [{ id: 'people' as const, label: 'People' }]
      : [])
  ]
  const allowedTab = (id?: string): TabId =>
    tabs.some(item => item.id === id) ? (id as TabId) : 'seasons'
  const [tab, setTab] = useState<TabId>(allowedTab(initialTab))
  useEffect(() => {
    const next = allowedTab(initialTab)
    setTab(next)
    if (initialTab != null && initialTab !== next) onTab?.(next, true)
    // Tab validity changes when management rights do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTab, detail.canSeePeople])
  const chooseTab = (next: TabId): void => {
    setTab(next)
    onTab?.(next)
  }
  const [creatingTeam, setCreatingTeam] = useState(false)
  const breaker = useBreakParent(client, props.onChanged, {
    danger: true,
    cancelLabel: 'Cancel'
  })

  const { headerHeight } = useHeaderSlot()
  const handoff = useHandoff(headerHeight)
  const progress = handoff.progress
  useHeaderHandoff(
    useMemo(
      () => (
        <HandoffView progress={progress} style={styles.headerHandoff}>
          <Emblem
            uri={group.imageUrl}
            fallback={initialsOf(group.name)}
            size={1.75}
          />
          <Text style={styles.headerName} numberOfLines={1}>
            {group.name}
          </Text>
        </HandoffView>
      ),
      [
        group.imageUrl,
        group.name,
        progress,
        styles.headerHandoff,
        styles.headerName
      ]
    )
  )

  const seasons = detail.children
    .filter(child => child.kind === 'season')
    .sort((a, b) => {
      // Most recent start first, whenever it ends; no dates last.
      const start = (b.startsOn ?? '').localeCompare(a.startsOn ?? '')
      return start !== 0 ? start : a.name.localeCompare(b.name)
    })
  const seasonNames = new Map(seasons.map(season => [season.id, season.name]))
  const childTeamIds = new Set(
    detail.children.filter(child => child.kind === 'team').map(team => team.id)
  )
  const teams = [
    ...new Map(
      [
        ...detail.children.filter(child => child.kind === 'team'),
        ...detail.keptTeams
      ].map(team => [team.id, team])
    ).values()
  ].sort((a, b) => a.name.localeCompare(b.name))

  return (
    <StickySectionLayout
      onScroll={handoff.handleScroll}
      hero={
        <Card style={styles.identity} ref={handoff.ref}>
          <View style={styles.identityTop}>
            <Emblem
              uri={group.imageUrl}
              fallback={initialsOf(group.name)}
              size={2.25}
            />
            <Text style={styles.name}>{group.name}</Text>
            {detail.canManage && (
              <SettingsGear
                label="League settings"
                onPress={() => {
                  props.onSettings(league)
                }}
              />
            )}
          </View>
          <Text style={styles.meta}>
            {group.locality == null
              ? 'Location not set'
              : localityLabel(group.locality)}
          </Text>
        </Card>
      }
      sections={
        <PillTabs
          tabs={tabs}
          selected={tab}
          onSelect={chooseTab}
          accessibilityLabel="League sections"
        />
      }
    >
      {breaker.error !== '' && (
        <Text accessibilityRole="alert" style={styles.error}>
          {breaker.error}
        </Text>
      )}
      {tab === 'seasons' && (
        <View style={styles.section}>
          <SectionHeader
            title="Seasons"
            note={String(seasons.length)}
            actions={
              detail.canManage
                ? [
                    {
                      label: 'Add',
                      accessibilityLabel: 'Add season',
                      onPress: () => {
                        onLink({
                          subject: league,
                          targetKind: 'season',
                          relationship: 'parent',
                          direction: 'children'
                        })
                      }
                    },
                    {
                      label: 'Create',
                      accessibilityLabel: 'Create season',
                      onPress: () => {
                        onCreate('season', league, group.locality)
                      }
                    }
                  ]
                : undefined
            }
          />
          {seasons.length === 0 && (
            <Card>
              <Text style={styles.muted}>No seasons in this league yet.</Text>
            </Card>
          )}
          <ActionList bounded={seasons.length > 0}>
            {seasons.map(season => (
              <GroupRelationshipRow
                key={season.id}
                group={season}
                detail={seasonPeriodLabel(season.startsOn, season.endsOn)}
                onOpen={() => {
                  onOpen({ kind: 'season', id: season.id })
                }}
                label={`Leave ${season.name} from ${group.name}`}
                disabled={breaker.busy}
                onLeave={
                  !detail.canManage
                    ? undefined
                    : () => {
                        breaker.review(
                          { kind: 'season', id: season.id },
                          league
                        )
                      }
                }
              />
            ))}
          </ActionList>
        </View>
      )}
      {tab === 'teams' && (
        <View style={styles.section}>
          <SectionHeader
            title="Teams"
            note={String(teams.length)}
            actions={
              detail.canManage
                ? [
                    {
                      label: 'Add',
                      accessibilityLabel: 'Add team',
                      onPress: () => {
                        onLink({
                          subject: league,
                          targetKind: 'team',
                          relationship: 'parent',
                          direction: 'children'
                        })
                      }
                    },
                    {
                      label: 'Create',
                      accessibilityLabel: 'Create team',
                      onPress: () => {
                        if (props.onCreateExternal == null)
                          onCreate('team', league, group.locality)
                        else setCreatingTeam(true)
                      }
                    }
                  ]
                : undefined
            }
          />
          {teams.length === 0 && (
            <Card>
              <Text style={styles.muted}>No teams in this league yet.</Text>
            </Card>
          )}
          <ScopedThemeProvider theme={teamListTheme}>
            <ActionList bounded={teams.length > 0} testID="league-teams-card">
              {teams.map(team => (
                <GroupRelationshipRow
                  key={team.id}
                  group={team}
                  detail={[
                    team.external ? 'Placeholder team' : undefined,
                    team.locality == null
                      ? undefined
                      : localityLabel(team.locality)
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                  onOpen={() => {
                    onOpen({ kind: 'team', id: team.id })
                  }}
                  links={(
                    detail.teamSeasons.find(row => row.teamId === team.id)
                      ?.seasonIds ?? []
                  )
                    .filter(id => seasonNames.has(id))
                    .map(id => ({
                      label: seasonNames.get(id)!,
                      onPress: () => {
                        onOpen({ kind: 'season', id })
                      }
                    }))}
                  label={`Leave ${team.name} from ${group.name}`}
                  disabled={breaker.busy}
                  onLeave={
                    !detail.canManage || !childTeamIds.has(team.id)
                      ? undefined
                      : () => {
                          breaker.review({ kind: 'team', id: team.id }, league)
                        }
                  }
                />
              ))}
            </ActionList>
          </ScopedThemeProvider>
        </View>
      )}
      {tab === 'people' && detail.canSeePeople === true && (
        <LevelPeopleTab
          client={client}
          kind="league"
          id={group.id}
          onOpenPlayer={props.onOpenPlayer}
          onOpenPerson={props.onOpenPerson}
        />
      )}
      {breaker.sheet}
      {creatingTeam && (
        <ChoiceSheet
          title="Create"
          choices={[
            {
              label: 'Team',
              detail: `A team managed by ${group.name}.`,
              onPress: () => {
                onCreate('team', league, group.locality)
              }
            },
            {
              label: 'Placeholder team',
              detail: `A stand-in for a team without its own administrator, kept by ${group.name}.`,
              onPress: () => {
                props.onCreateExternal?.(league)
              }
            }
          ]}
          onClose={() => {
            setCreatingTeam(false)
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
  name: {
    flex: 1,
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.5),
    fontWeight: '700',
    color: theme.primaryTextColor
  },
  meta: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  gear: {
    width: theme.rem(2),
    height: theme.rem(2),
    borderRadius: theme.rem(1),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.containerBackgroundColor
  },
  pressed: { opacity: 0.6 },
  section: { gap: theme.rem(theme.spaceMdRem) },
  muted: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.secondaryTextColor
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.dangerColor
  }
}))
