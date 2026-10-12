import React, { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { GroupKind, GroupRef } from '../../common/groupCreation'
import { localityLabel } from '../../common/locality'
import type { PublicGroup } from '../../common/publicGroups'
import { formatDateRange } from '../../common/seasonTimeFrames'
import {
  Button,
  Card,
  Emblem,
  initialsOf,
  Screen,
  TextField
} from '../components'
import { useTitleHandoff } from '../components/useTitleHandoff'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export function DiscoverScreen({
  client,
  onOpen,
  initialKind = 'team',
  follow = false,
  onFollowed
}: {
  client: TeamStationClient
  onOpen: (ref: GroupRef) => void
  initialKind?: GroupKind
  /** Each result gets a Follow pill, for a fan adding it to their Home. */
  follow?: boolean
  onFollowed?: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const handoff = useTitleHandoff('Discover')
  const [kind, setKind] = useState<GroupKind>(initialKind)
  const [followed, setFollowed] = useState<Set<string>>(new Set())
  /** Groups already on the person's Home because they belong to or run them. */
  const [own, setOwn] = useState<Set<string>>()
  const [following, setFollowing] = useState<string>()
  const [followError, setFollowError] = useState('')
  useEffect(() => {
    if (!follow) return
    let active = true
    const keys = (groups: PublicGroup[]): Set<string> =>
      new Set(groups.map(group => `${group.kind}:${group.id}`))
    Promise.all([client.follows(), client.ownGroups()]).then(
      ([follows, groups]) => {
        if (!active) return
        setFollowed(keys(follows))
        setOwn(keys(groups))
      },
      () => undefined
    )
    return () => {
      active = false
    }
  }, [client, follow])
  const toggle = (group: PublicGroup): void => {
    const key = `${group.kind}:${group.id}`
    const ref = { kind: group.kind, id: group.id }
    const was = followed.has(key)
    setFollowing(key)
    setFollowError('')
    ;(was ? client.unfollow(ref) : client.follow(ref).then(() => undefined))
      .then(
        () => {
          setFollowed(current => {
            const next = new Set(current)
            if (was) next.delete(key)
            else next.add(key)
            return next
          })
          onFollowed?.()
        },
        (error: unknown) => {
          setFollowError(
            error instanceof Error
              ? error.message
              : `${group.name} could not be ${was ? 'unfollowed' : 'followed'}. Retry.`
          )
        }
      )
      .finally(() => {
        setFollowing(undefined)
      })
  }
  const [query, setQuery] = useState('')
  const [groups, setGroups] = useState<PublicGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let active = true
    const timer = setTimeout(() => {
      setLoading(true)
      client
        .discoverGroups(kind, query)
        .then(
          found => {
            if (active) {
              setGroups(found)
              setError('')
            }
          },
          (error: unknown) => {
            if (active)
              setError(
                error instanceof Error
                  ? error.message
                  : 'Discovery could not load. Retry.'
              )
          }
        )
        .finally(() => {
          if (active) setLoading(false)
        })
    }, 250)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [client, kind, query, retry])
  return (
    <Screen onScroll={handoff.handleScroll}>
      <View style={styles.page}>
        <View ref={handoff.ref} collapsable={false}>
          <Text style={styles.title} accessibilityRole="header">
            Discover
          </Text>
        </View>
        <Text style={styles.hint}>
          {follow
            ? 'Follow leagues, seasons and teams to keep them on your Home. A team opens on its own page, followed or not: its schedule, results and roster, with videos and player stats for its members.'
            : 'Find leagues, seasons and teams. Public profiles show location, parent organizations, schedules and results.'}
        </Text>
        <View style={styles.tabs}>
          {(['league', 'season', 'team'] as const).map(value => (
            <Button
              key={value}
              label={
                value === 'league'
                  ? 'Leagues'
                  : value === 'season'
                    ? 'Seasons'
                    : 'Teams'
              }
              compact
              kind={kind === value ? 'primary' : 'secondary'}
              onPress={() => {
                setKind(value)
              }}
            />
          ))}
        </View>
        <TextField
          label="Search by name or city"
          value={query}
          onChangeText={setQuery}
        />
        {loading && <Text style={styles.hint}>Loading…</Text>}
        {followError !== '' && (
          <Text accessibilityRole="alert" style={styles.error}>
            {followError}
          </Text>
        )}
        {error !== '' && (
          <>
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
            <Button
              label="Retry discovery"
              kind="secondary"
              onPress={() => {
                setRetry(retry + 1)
              }}
            />
          </>
        )}
        {!loading && error === '' && groups.length === 0 && (
          <Text style={styles.hint}>
            No matching{' '}
            {kind === 'league'
              ? 'leagues'
              : kind === 'season'
                ? 'seasons'
                : 'teams'}
            .
          </Text>
        )}
        {groups.map(group => {
          const key = `${group.kind}:${group.id}`
          const isFollowed = followed.has(key)
          return (
            <Card key={group.id} style={styles.result}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open ${group.name}${groups.filter(candidate => candidate.name === group.name).length < 2 ? '' : ', ' + (group.locality == null ? 'Location not set' : localityLabel(group.locality))}`}
                onPress={() => {
                  onOpen({ kind: group.kind, id: group.id })
                }}
                style={styles.open}
              >
                <Emblem
                  uri={group.imageUrl}
                  fallback={initialsOf(group.name)}
                  size={3}
                />
                <View style={styles.details}>
                  <Text style={styles.name}>{group.name}</Text>
                  {group.parentNames.length > 0 && (
                    <Text style={styles.hint}>
                      Parents: {group.parentNames.join(', ')}
                    </Text>
                  )}
                  <Text style={styles.hint}>
                    {group.locality == null
                      ? 'Location not set'
                      : localityLabel(group.locality)}
                  </Text>
                  {group.kind === 'season' && (
                    <Text style={styles.hint}>
                      {formatDateRange(group.startsOn, group.endsOn)}
                    </Text>
                  )}
                  {group.external && (
                    <Text style={styles.hint}>Placeholder team</Text>
                  )}
                </View>
              </Pressable>
              {follow && own != null && !own.has(key) && (
                <Button
                  label={isFollowed ? 'Following' : 'Follow'}
                  accessibilityLabel={`${isFollowed ? 'Unfollow' : 'Follow'} ${group.name}`}
                  compact
                  kind={isFollowed ? 'secondary' : 'primary'}
                  busy={following === key}
                  onPress={() => {
                    toggle(group)
                  }}
                />
              )}
            </Card>
          )
        })}
      </View>
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1) },
  title: {
    fontSize: theme.rem(1.5),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont
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
  tabs: {
    flexDirection: 'row' as const,
    flexWrap: 'wrap' as const,
    gap: theme.rem(0.5)
  },
  result: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.rem(1)
  },
  open: {
    flex: 1,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.rem(1)
  },
  details: { flex: 1, gap: theme.rem(0.25) }
}))
