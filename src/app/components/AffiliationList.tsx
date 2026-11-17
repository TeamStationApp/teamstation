import React, { useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import type {
  AccountAffiliationGroup,
  AccountAffiliationPlayer,
  AccountAffiliations,
  TeamStationClient
} from '../../common/api'
import type { GroupRef } from '../../common/groupCreation'
import { ROLE_FLAGS } from '../../common/roles'
import { lstrings, sprintf } from '../locales/strings'
import { pillPadding } from '../theme/pill'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { ActionList, ActionRow } from './ActionRow'
import { Badge } from './Badge'
import { ButtonIcon } from './ButtonIcon'
import { GroupEmblem } from './GroupEmblem'
import { PersonEmblem } from './PersonEmblem'
import { positionLabel } from './roleLabels'
import { useSceneReveals } from './sceneShown'
import { SectionHeader } from './SectionHeader'
import { useConfirmedAction } from './useConfirmedAction'

export interface AffiliationListProps {
  client: TeamStationClient
  /** A league, season or team, opened on its page. */
  onOpenGroup?: (group: GroupRef) => void
  /** A player the person guards, opened on their page. */
  onOpenPlayer?: (userId: string, name: string) => void
}

/**
 * What the person is on a group, as read-only pills: Admin, each staff role
 * they hold there, Player, and Spectator for a membership with nothing else.
 * Following is not a pill here: a row that only follows says so on its own.
 */
export function affiliationPills(group: AccountAffiliationGroup): string[] {
  const pills: string[] = []
  if (group.roles.includes('admin')) pills.push(lstrings.affiliation_admin)
  for (const flag of ROLE_FLAGS)
    if (group.roles.includes(flag))
      pills.push(positionLabel(flag, group.headCoach))
  if (group.player) pills.push(lstrings.affiliation_player)
  if (group.member && pills.length === 0)
    pills.push(lstrings.affiliation_spectator)
  return pills
}

/**
 * The account screen's Affiliations: each league, season and team the person
 * belongs to directly, then each player they guard, one row each with a
 * chevron that opens it. A group they only follow carries a Following pill
 * instead of pills, which stops the follow once confirmed.
 */
export function AffiliationList(
  props: AffiliationListProps
): React.ReactElement {
  const { client, onOpenGroup, onOpenPlayer } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [answer, setAnswer] = useState<AccountAffiliations | undefined>()
  const [error, setError] = useState<string | undefined>()
  const confirmation = useConfirmedAction(client, 'affiliations')

  // Each read and each unfollow takes the next number: a read answers only
  // while nothing has been read or unfollowed since it started, so a read
  // begun before an unfollow cannot bring the row back. The unfollow then
  // reads again, so whatever else that read would have brought still comes.
  const changes = useRef(0)
  // Read again once an unfollow lands, for whatever a dropped read held.
  const [unfollows, setUnfollows] = useState(0)
  // A follow, a role or a membership changed on a screen pushed over this.
  const reveals = useSceneReveals()
  useEffect(() => {
    let live = true
    const started = ++changes.current
    const current = (): boolean => live && changes.current === started
    client
      .accountAffiliations()
      .then(found => {
        if (current()) {
          setAnswer(found)
          setError(undefined)
        }
      })
      .catch((caught: unknown) => {
        if (current())
          setError(
            caught instanceof Error
              ? caught.message
              : lstrings.affiliations_error
          )
      })
    return () => {
      live = false
    }
  }, [client, reveals, unfollows])

  const count =
    answer == null ? undefined : answer.groups.length + answer.players.length
  const unfollow = (group: AccountAffiliationGroup): void => {
    const name = group.group.name
    confirmation.open({
      title: sprintf(lstrings.affiliation_unfollow_title, name),
      detail: sprintf(lstrings.affiliation_unfollow_detail, name),
      label: lstrings.affiliation_unfollow_confirm,
      fallback: sprintf(lstrings.affiliation_unfollow_failed, name),
      testID: 'affiliation-unfollow-confirm',
      run: async current => {
        await client.unfollow({ kind: group.kind, id: group.id })
        changes.current++
        if (!current()) return
        setUnfollows(count => count + 1)
        setAnswer(held =>
          held == null
            ? held
            : {
                ...held,
                groups: held.groups.filter(
                  row => !(row.kind === group.kind && row.id === group.id)
                )
              }
        )
      }
    })
  }

  const groupRow = (group: AccountAffiliationGroup): React.ReactElement => {
    const name = group.group.name
    const pills = affiliationPills(group)
    const open =
      onOpenGroup == null
        ? undefined
        : () => {
            onOpenGroup({ kind: group.kind, id: group.id })
          }
    const leading = (
      <GroupEmblem
        kind={group.kind}
        id={group.id}
        leagueId={group.group.leagueId}
        name={name}
        uri={group.group.imageUrl}
        leagueUri={group.group.leaguePictureUrl}
      />
    )
    const detail =
      group.group.parentNames.length === 0
        ? undefined
        : group.group.parentNames.join(' · ')
    if (pills.length === 0 && group.following)
      return (
        <ActionRow
          key={`${group.kind}:${group.id}`}
          title={name}
          detail={detail}
          leading={leading}
          onOpen={open}
          openLabel={sprintf(lstrings.affiliation_open, name)}
          separateEndAction
          end={
            <View style={styles.end}>
              <Pressable
                testID="affiliation-following"
                accessibilityRole="button"
                accessibilityLabel={sprintf(
                  lstrings.affiliation_following_label,
                  name
                )}
                disabled={confirmation.busy}
                hitSlop={8}
                onPress={() => {
                  unfollow(group)
                }}
                style={({ pressed }) => [
                  styles.target,
                  pressed && styles.pressed
                ]}
              >
                <View style={styles.following}>
                  <Text style={styles.followingText}>
                    {lstrings.affiliation_following}
                  </Text>
                </View>
              </Pressable>
              {open != null && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={sprintf(lstrings.affiliation_open, name)}
                  onPress={open}
                  style={styles.target}
                >
                  <ButtonIcon name="chevron_right" />
                </Pressable>
              )}
            </View>
          }
        />
      )
    return (
      <ActionRow
        key={`${group.kind}:${group.id}`}
        title={name}
        detail={detail}
        leading={leading}
        onOpen={open}
        openLabel={sprintf(lstrings.affiliation_open, name)}
        extra={<Pills labels={pills} />}
      />
    )
  }

  const playerRow = (player: AccountAffiliationPlayer): React.ReactElement => (
    <ActionRow
      key={`player:${player.userId}`}
      title={player.name}
      detail={player.teamNames.join(', ')}
      leading={
        <PersonEmblem
          userId={player.userId}
          name={player.name}
          uri={player.avatarUrl}
        />
      }
      onOpen={
        onOpenPlayer == null
          ? undefined
          : () => {
              onOpenPlayer(player.userId, player.name)
            }
      }
      openLabel={sprintf(lstrings.affiliation_open, player.name)}
      extra={<Pills labels={[lstrings.affiliation_guardian]} />}
    />
  )

  return (
    <View style={styles.section} testID="account-affiliations">
      <SectionHeader
        title={lstrings.affiliations_title}
        note={count == null ? undefined : String(count)}
      />
      {answer == null ? (
        <Text
          accessibilityRole={error == null ? undefined : 'alert'}
          style={styles.muted}
        >
          {error ?? lstrings.common_loading}
        </Text>
      ) : (
        <>
          {/* A reload that failed: the rows below are from the last read. */}
          {error != null && (
            <Text accessibilityRole="alert" style={styles.muted}>
              {error}
            </Text>
          )}
          {count !== 0 && (
            <ActionList bounded>
              {answer.groups.map(groupRow)}
              {answer.players.map(playerRow)}
            </ActionList>
          )}
        </>
      )}
      {confirmation.sheet}
    </View>
  )
}

function Pills({ labels }: { labels: string[] }): React.ReactElement {
  const styles = getStyles(useTheme())
  return (
    <View style={styles.pills} pointerEvents="none">
      {labels.map(label => (
        <Badge key={label} label={label} tone="neutral" />
      ))}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  section: { gap: theme.rem(theme.spaceMdRem) },
  muted: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.secondaryTextColor
  },
  pills: {
    flexDirection: 'row' as const,
    flexWrap: 'wrap' as const,
    gap: theme.rem(0.375)
  },
  // At the row's upper right, beside the name rather than centred on it.
  end: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.rem(0.25),
    marginBottom: 'auto' as const,
    paddingTop: theme.rem(theme.cardContentInsetRem) - theme.rem(0.5)
  },
  target: { minHeight: 48, justifyContent: 'center' as const },
  following: {
    backgroundColor: theme.containerBackgroundColor,
    borderRadius: theme.radiusPill,
    paddingHorizontal: pillPadding(theme.rem(1.75)),
    height: theme.rem(1.75),
    minHeight: theme.rem(1.75),
    justifyContent: 'center' as const
  },
  followingText: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.8125),
    fontWeight: '600' as const,
    color: theme.activeColor
  },
  pressed: { opacity: 0.6 }
}))
