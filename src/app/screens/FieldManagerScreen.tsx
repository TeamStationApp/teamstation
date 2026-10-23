import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { VenueSummary } from '../../common/venues'
import { Badge, Button, Card, Icon, Screen, TextField } from '../components'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { currentPosition, type Position } from '../platform/currentPosition'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

const GROUP_TITLES: Record<VenueSummary['group'], string> = {
  yours: 'Your leagues’ venues',
  claimed: 'Claimed venues',
  unclaimed: 'Unclaimed venues'
}

/**
 * Finds venues. It opens on the person's leagues' venues and the claimed
 * venues near them; a search adds unclaimed venues and places from Google
 * Maps after those.
 */
export function FieldManagerScreen({
  client,
  onOpenVenue,
  onOpenPlace,
  locate = currentPosition
}: {
  client: TeamStationClient
  onOpenVenue: (venueId: string) => void
  onOpenPlace: (placeId: string) => void
  /** Where the person is, for "nearby"; the device's position by default. */
  locate?: () => Promise<Position | null>
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [query, setQuery] = useState('')
  const [position, setPosition] = useState<Position | null | undefined>()
  const [items, setItems] = useState<VenueSummary[]>()
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const begin = useLatestRequest()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    let active = true
    locate().then(
      found => {
        if (active) setPosition(found)
      },
      () => {
        if (active) setPosition(null)
      }
    )
    return () => {
      active = false
    }
  }, [locate])
  const load = useCallback(
    (search: string, near: Position | null) => {
      const current = begin()
      setError('')
      client
        .venues({ query: search, near: near ?? undefined })
        .then(found => {
          if (current()) setItems(found)
        })
        .catch(() => {
          if (current()) setError('Venues could not load. Try again.')
        })
    },
    [client, begin]
  )
  // Lists at once, without waiting for a location prompt the person may
  // never answer; a position, when it comes, sorts the list by distance.
  useEffect(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(
      () => {
        load(query, position ?? null)
      },
      query === '' ? 0 : 300
    )
    return () => {
      clearTimeout(timer.current)
    }
  }, [query, position, revision, load])
  const groups = (['yours', 'claimed', 'unclaimed'] as const)
    .map(group => ({
      group,
      rows: (items ?? []).filter(item => item.group === group)
    }))
    .filter(entry => entry.rows.length > 0)
  return (
    <Screen>
      <View style={styles.page}>
        <Text accessibilityRole="header" style={styles.title}>
          Field Manager
        </Text>
        <TextField
          label="Search venues"
          value={query}
          onChangeText={setQuery}
          placeholder="A park, school or address"
          leadingIcon="search"
          autoCapitalize="words"
        />
        {position === null && query === '' && (
          <Text style={styles.note}>
            Allow location access to see claimed venues near you. Your leagues’
            venues are listed either way.
          </Text>
        )}
        {error !== '' && (
          <View style={styles.errorRow}>
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
            <Button
              label="Retry"
              kind="secondary"
              small
              onPress={() => {
                setRevision(value => value + 1)
              }}
            />
          </View>
        )}
        {items == null && error === '' && (
          <ActivityIndicator accessibilityLabel="Loading venues" />
        )}
        {items?.length === 0 && (
          <Text style={styles.note}>
            {query === ''
              ? 'No claimed venues yet. Search for a park, school or address to claim one.'
              : 'No venues match. Try another name or an address.'}
          </Text>
        )}
        {groups.map(({ group, rows }) => (
          <View key={group} style={styles.group}>
            <Text accessibilityRole="header" style={styles.groupTitle}>
              {group === 'claimed' && query === '' && position != null
                ? 'Claimed venues nearby'
                : GROUP_TITLES[group]}
            </Text>
            {rows.map(item => (
              <VenueCard
                key={item.id ?? item.placeId}
                item={item}
                onPress={() => {
                  if (item.id == null) onOpenPlace(item.placeId)
                  else onOpenVenue(item.id)
                }}
              />
            ))}
          </View>
        ))}
      </View>
    </Screen>
  )
}

/** One venue in a list: its name and address, and who owns it. */
export function VenueCard({
  item,
  onPress
}: {
  item: VenueSummary
  onPress: () => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  return (
    <Card style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${item.name}`}
        onPress={onPress}
        style={styles.cardBody}
      >
        <View style={styles.tile}>
          <Icon name="stadium" size={1.5} />
        </View>
        <View style={styles.cardText}>
          <Text style={styles.name} numberOfLines={1}>
            {item.name}
          </Text>
          {item.address !== '' && (
            <Text style={styles.address} numberOfLines={2}>
              {item.address}
            </Text>
          )}
          <View style={styles.pills}>
            {item.owners.map(owner => (
              <Badge key={owner.claimId} label={owner.name} tone="win" />
            ))}
            {item.pendingClaim && <Badge label="Claim pending" tone="honour" />}
            {!item.claimed && !item.pendingClaim && <Badge label="Unclaimed" />}
            {item.distanceKm != null && (
              <Text style={styles.distance}>{item.distanceKm} km</Text>
            )}
          </View>
        </View>
        <Icon name="chevron_right" size={1.25} />
      </Pressable>
    </Card>
  )
}

export const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1), paddingBottom: theme.rem(6) },
  title: {
    fontFamily: theme.primaryTextFont,
    fontSize: theme.rem(1.75),
    color: theme.primaryTextColor
  },
  note: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.secondaryTextColor
  },
  errorRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.rem(0.75)
  },
  error: {
    flex: 1,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.dangerColor
  },
  group: { gap: theme.rem(0.75) },
  groupTitle: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(0.75),
    letterSpacing: 1,
    textTransform: 'uppercase' as const,
    color: theme.secondaryTextColor
  },
  card: { padding: 0 },
  cardBody: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: theme.rem(0.75),
    padding: theme.rem(0.875),
    minHeight: theme.rem(3)
  },
  tile: {
    width: theme.rem(2.75),
    height: theme.rem(2.75),
    borderRadius: theme.rem(0.75),
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    backgroundColor: theme.containerBackgroundColor
  },
  cardText: { flex: 1, gap: theme.rem(0.25) },
  name: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  },
  address: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  pills: {
    flexDirection: 'row' as const,
    flexWrap: 'wrap' as const,
    alignItems: 'center' as const,
    gap: theme.rem(0.375),
    marginTop: theme.rem(0.25)
  },
  distance: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  }
}))
