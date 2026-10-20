import React, { useCallback, useState } from 'react'
import { Text, View } from 'react-native'

import type { TeamStationClient, TeamSummary } from '../../common/api'
import type { GroupKind, GroupRef } from '../../common/groupCreation'
import type { GroupDetail, PublicGroup } from '../../common/publicGroups'
import { Button, Screen } from '../components'
import { useForegroundRefresh } from '../hooks/useForegroundRefresh'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import type { GameListOpenOptions } from './gameListOptions'
import { GroupGameSchedule } from './GroupGameSchedule'
import { LeaguePage } from './LeaguePage'
import { SeasonPresentation } from './SeasonPresentation'
import { TeamPage } from './TeamPage'
import type { TeamScreenProps } from './TeamScreen'
import type { When } from './whenFilter'

export interface GroupLinkChoice {
  subject: GroupRef
  targetKind: GroupKind
  relationship: 'parent' | 'participation'
  direction: 'children' | 'parents'
}
export interface GroupScreenProps {
  client: TeamStationClient
  signedIn?: boolean
  onSignIn?: () => void
  groupRef: GroupRef
  onOpen: (group: GroupRef) => void
  onOpenTeam?: (team: TeamSummary) => void
  onOpenPlayer?: TeamScreenProps['onOpenPlayer']
  /** Somebody on a team's, season's or league's people list, as a profile. */
  onOpenPerson?: (group: GroupRef, userId: string, name: string) => void
  onCreate: (
    kind: GroupKind,
    parent: GroupRef,
    locality?: PublicGroup['locality']
  ) => void
  onSettings: (group: GroupRef) => void
  onLink: (choice: GroupLinkChoice) => void
  onPrivate: (group: GroupRef) => void
  onCreateGame?: (group: GroupRef) => void
  onPromote?: (group: GroupRef) => void
  onCreateExternal?: (custodian: GroupRef) => void
  onOpenRequest?: (id: string) => void
  onOpenGame?: (
    gameId: string,
    title: string,
    options?: GameListOpenOptions
  ) => void
  initialTab?: string
  onTab?: (tab: string, correcting?: boolean) => void
  initialWhen?: When
  onWhen?: (when: When) => void
}

export function GroupScreen(props: GroupScreenProps): React.ReactElement {
  if (props.groupRef.kind === 'team')
    return (
      <TeamPage
        signedIn={props.signedIn}
        onSignIn={props.onSignIn}
        client={props.client}
        id={props.groupRef.id}
        initialTab={props.initialTab}
        onTab={props.onTab}
        onOpenGame={props.onOpenGame ?? (() => undefined)}
        onOpenPlayer={props.onOpenPlayer}
        onCreateGame={
          props.onCreateGame == null
            ? undefined
            : id => {
                props.onCreateGame?.({ kind: 'team', id })
              }
        }
        onOpenPerson={
          props.onOpenPerson == null
            ? undefined
            : (userId, name, teamId) => {
                props.onOpenPerson?.({ kind: 'team', id: teamId }, userId, name)
              }
        }
        onSettings={id => {
          props.onSettings({ kind: 'team', id })
        }}
      />
    )
  return (
    <GroupContent
      key={`${props.groupRef.kind}:${props.groupRef.id}`}
      {...props}
    />
  )
}

function GroupContent({
  client,
  groupRef,
  onOpen,
  onOpenTeam,
  onOpenPlayer,
  onOpenPerson,
  onCreate,
  onSettings,
  onLink,
  onPrivate,
  onCreateGame,
  onPromote,
  onCreateExternal,
  onOpenRequest,
  onOpenGame,
  initialTab,
  onTab,
  initialWhen,
  onWhen
}: Omit<GroupScreenProps, 'signedIn' | 'onSignIn'>): React.ReactElement {
  const styles = getStyles(useTheme())
  const { kind, id } = groupRef
  const [detail, setDetail] = useState<GroupDetail | undefined>()
  const [error, setError] = useState('')
  const begin = useLatestRequest()
  const load = useCallback(async (): Promise<void> => {
    const current = begin()
    try {
      const found = await client.group({ kind, id })
      if (!current()) return
      setDetail(found)
      setError('')
    } catch (error) {
      if (!current()) return
      setDetail(undefined)
      setError(
        error instanceof Error
          ? error.message
          : 'The group could not load. Retry.'
      )
    }
  }, [client, kind, id, begin])
  useForegroundRefresh(load)
  if (detail == null)
    return (
      <Screen>
        {error === '' ? (
          <Text style={styles.hint}>Loading…</Text>
        ) : (
          <>
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
            <Button
              label="Retry group"
              kind="secondary"
              onPress={() => {
                load().catch(() => undefined)
              }}
            />
          </>
        )}
      </Screen>
    )
  const { group } = detail
  const canonical: GroupRef = { kind: group.kind, id: group.id }
  const link = (
    targetKind: GroupKind,
    relationship: GroupLinkChoice['relationship'] = 'parent'
  ): void => {
    onLink({
      subject: { kind: group.kind, id: group.id },
      targetKind,
      relationship,
      direction: 'children'
    })
  }
  if (group.kind === 'season') {
    return (
      <SeasonPresentation
        client={client}
        season={{
          id: group.id,
          name: group.name,
          leagueId:
            detail.parents.find(parent => parent.kind === 'league')?.id ?? null,
          year: Number(group.startsOn?.slice(0, 4) ?? new Date().getFullYear()),
          term: null,
          ageGroup: null,
          logoUrl: group.imageUrl,
          teams: detail.competingTeams.length,
          games: detail.games.length,
          videos: 0
        }}
        publicDetail={detail}
        onOpenPlayer={
          onOpenPlayer == null
            ? undefined
            : (userId, name, from) => {
                onOpenPlayer(userId, name, from)
              }
        }
        onOpenPerson={
          onOpenPerson == null
            ? undefined
            : (userId, name) => {
                onOpenPerson(canonical, userId, name)
              }
        }
        onOpenGame={onOpenGame ?? (() => undefined)}
        onOpenTeam={team => {
          if (onOpenTeam != null) onOpenTeam(team)
          else onOpen({ kind: 'team', id: team.id })
        }}
        onSettings={
          detail.canManage
            ? () => {
                onSettings(canonical)
              }
            : undefined
        }
        initialTab={initialTab}
        onTab={onTab}
        initialWhen={initialWhen}
        onWhen={onWhen}
        management={
          detail.canManage
            ? {
                onAddTeam: relationship => {
                  link('team', relationship)
                },
                onCreateTeam: () => {
                  onCreate('team', canonical, group.locality)
                },
                onCreatePlaceholder:
                  onCreateExternal == null
                    ? undefined
                    : () => {
                        onCreateExternal(canonical)
                      },
                onOpenRequest,
                onChanged: () => {
                  load().catch(() => undefined)
                }
              }
            : undefined
        }
        scheduleActions={
          detail.canManage && (
            <View style={styles.actions}>
              {onCreateGame != null && (
                <Button
                  label="Create Game"
                  onPress={() => {
                    onCreateGame(canonical)
                  }}
                />
              )}
              {onOpenRequest != null && (
                <GroupGameSchedule
                  client={client}
                  groupRef={canonical}
                  onRequest={onOpenRequest}
                />
              )}
            </View>
          )
        }
      />
    )
  }
  return (
    <LeaguePage
      client={client}
      detail={detail}
      onOpen={onOpen}
      onCreate={onCreate}
      onSettings={onSettings}
      onLink={onLink}
      onCreateExternal={onCreateExternal}
      onOpenPlayer={
        onOpenPlayer == null
          ? undefined
          : (userId, name) => {
              onOpenPlayer(userId, name)
            }
      }
      onOpenPerson={
        onOpenPerson == null
          ? undefined
          : (userId, name) => {
              onOpenPerson(canonical, userId, name)
            }
      }
      onChanged={() => {
        load().catch(() => undefined)
      }}
      initialTab={initialTab}
      onTab={onTab}
    />
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1.25) },
  title: {
    fontSize: theme.rem(1.75),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    textAlign: 'center' as const
  },
  name: {
    fontSize: theme.rem(1.125),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
  },
  hint: {
    fontSize: theme.rem(0.875),
    lineHeight: theme.rem(1.35),
    color: theme.secondaryTextColor
  },
  error: { fontSize: theme.rem(0.875), color: theme.dangerColor },
  hero: {
    padding: theme.rem(1.25),
    alignItems: 'center' as const,
    gap: theme.rem(0.75)
  },
  gear: {
    position: 'absolute',
    top: theme.rem(1),
    right: theme.rem(1),
    width: theme.rem(2),
    height: theme.rem(2),
    borderRadius: theme.rem(1),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.containerBackgroundColor
  },
  row: { padding: theme.rem(1), gap: theme.rem(0.375) },
  section: { gap: theme.rem(0.75) },
  actions: { gap: theme.rem(0.75) }
}))
