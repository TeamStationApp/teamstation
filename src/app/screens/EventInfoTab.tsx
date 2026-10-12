import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import {
  type EventInfo,
  type EventLocation,
  type Rsvp,
  RSVP_LABELS,
  RSVP_ORDER,
  sortedAttendees
} from '../../common/eventInfo'
import { Button, Card, Emblem, Icon, initialsOf } from '../components'
import { EventMap } from '../components/EventMap'
import { EventRsvpPill } from '../components/EventRsvpPill'
import { useForegroundRefresh } from '../hooks/useForegroundRefresh'
import {
  copyEventAddress,
  openEventDirections
} from '../platform/eventDirections'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { EventDetailsForm } from './EventDetailsForm'

export function EventInfoTab({
  client,
  eventId,
  onUpdated
}: {
  client: TeamStationClient
  eventId: string
  onUpdated?: () => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [info, setInfo] = useState<EventInfo>()
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState<Record<number, boolean>>({})
  const [replyErrors, setReplyErrors] = useState<Record<number, string>>({})
  const [notice, setNotice] = useState('')
  const [location, setLocation] = useState<EventLocation>()
  const [mapError, setMapError] = useState('')
  const [mapRetry, setMapRetry] = useState(0)
  const writes = useRef(new Set<number>())
  const generation = useRef(0)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      generation.current++
    }
  }, [])
  const refresh = useCallback(async (): Promise<void> => {
    const request = ++generation.current
    try {
      const found = await client.eventInfo(eventId)
      if (
        live.current &&
        request === generation.current &&
        writes.current.size === 0
      ) {
        setInfo(found)
        setError('')
      }
    } catch (error) {
      if (live.current && request === generation.current)
        setError(
          error instanceof Error
            ? error.message
            : 'Attendance could not load. Try again.'
        )
    }
  }, [client, eventId])
  useForegroundRefresh(refresh)
  const address = info?.address
  const latitude = info?.latitude
  const longitude = info?.longitude
  useEffect(() => {
    setLocation(undefined)
    setMapError('')
    if (address == null || address.trim() === '') return
    let active = true
    client.eventLocation(eventId).then(
      found => {
        if (!active) return
        if (found.latitude == null || found.longitude == null)
          setMapError('The address could not be located.')
        else setLocation(found)
      },
      (error: unknown) => {
        if (active)
          setMapError(
            error instanceof Error ? error.message : 'The map could not load.'
          )
      }
    )
    return () => {
      active = false
    }
  }, [address, latitude, longitude, client, eventId, mapRetry])
  const change = async (userId: number, response: Rsvp): Promise<void> => {
    if (writes.current.has(userId) || info == null) return
    const previous =
      info.attendees.find(row => row.userId === userId)?.response ?? null
    writes.current.add(userId)
    generation.current++
    setBusy(held => ({ ...held, [userId]: true }))
    setReplyErrors(held => ({ ...held, [userId]: '' }))
    const update = (reply: Rsvp | null): void => {
      setInfo(held =>
        held == null
          ? held
          : {
              ...held,
              attendees: sortedAttendees(
                held.attendees.map(row =>
                  row.userId === userId ? { ...row, response: reply } : row
                )
              )
            }
      )
    }
    update(response)
    try {
      await client.saveRsvp(eventId, userId, response)
    } catch (error) {
      if (live.current) {
        update(previous)
        setReplyErrors(held => ({
          ...held,
          [userId]:
            error instanceof Error
              ? error.message
              : 'Your RSVP could not be saved. Try again.'
        }))
      }
    } finally {
      writes.current.delete(userId)
      generation.current++
      if (live.current) setBusy(held => ({ ...held, [userId]: false }))
    }
  }
  const directions = (): void => {
    if (address == null) return
    setNotice('')
    openEventDirections(address).catch((error: unknown) => {
      if (live.current)
        setNotice(
          error instanceof Error ? error.message : 'Directions could not open.'
        )
    })
  }
  const copy = (): void => {
    if (address == null) return
    copyEventAddress(address).then(
      () => {
        if (live.current) setNotice('Address copied')
      },
      () => {
        if (live.current)
          setNotice('The address could not be copied. Try again.')
      }
    )
  }
  if (info == null)
    return (
      <View style={styles.section}>
        {error === '' ? (
          <ActivityIndicator accessibilityLabel="Loading event information" />
        ) : (
          <>
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
            <Button
              label="Retry event information"
              onPress={() => {
                refresh().catch(() => undefined)
              }}
            />
          </>
        )}
      </View>
    )
  if (editing)
    return (
      <View style={styles.section}>
        <EventDetailsForm
          client={client}
          info={info}
          onCancel={() => {
            setEditing(false)
          }}
          onSaved={(_id, updated) => {
            if (updated != null) setInfo(updated)
            generation.current++
            setEditing(false)
            onUpdated?.()
          }}
        />
      </View>
    )
  const own = info.replyUserIds.flatMap(id =>
    info.attendees.filter(row => row.userId === id && row.canReply)
  )
  const when =
    info.startAt == null
      ? ''
      : new Intl.DateTimeFormat('en', {
          timeZone: info.timezone,
          dateStyle: 'medium',
          timeStyle: 'short'
        }).format(new Date(info.startAt))
  return (
    <View style={styles.section} testID="event-info">
      {when !== '' && (
        <Text style={styles.detail}>
          {when}
          {info.endAt == null
            ? ''
            : ` – ${new Intl.DateTimeFormat('en', { timeZone: info.timezone, timeStyle: 'short' }).format(new Date(info.endAt))}`}{' '}
          · {info.timezone}
        </Text>
      )}
      {info.venue != null && <Text style={styles.name}>{info.venue}</Text>}
      {address != null && address.trim() !== '' && (
        <>
          <Card style={styles.location}>
            <View style={styles.addressRow}>
              <Pressable
                testID="event-address"
                accessibilityLabel={`Copy address: ${address}`}
                onLongPress={copy}
                delayLongPress={450}
                style={styles.addressText}
              >
                <Text selectable style={styles.name}>
                  {address}
                </Text>
              </Pressable>
              <Pressable
                testID="event-directions"
                accessibilityRole="button"
                accessibilityLabel="Open directions"
                onPress={directions}
                style={styles.chevron}
              >
                <Icon
                  name="chevron_right"
                  size={1.5}
                  color={theme.primaryTextColor}
                />
              </Pressable>
            </View>
            {location != null ? (
              <EventMap location={location} />
            ) : mapError === '' ? (
              <ActivityIndicator accessibilityLabel="Loading map" />
            ) : (
              <>
                <Text accessibilityRole="alert" style={styles.error}>
                  {mapError}
                </Text>
                <Button
                  label="Retry map"
                  kind="secondary"
                  onPress={() => {
                    setMapRetry(value => value + 1)
                  }}
                />
              </>
            )}
          </Card>
        </>
      )}
      {notice !== '' && (
        <Text accessibilityLiveRegion="polite" style={styles.detail}>
          {notice}
        </Text>
      )}
      <Card style={styles.attendance}>
        <Text accessibilityRole="header" style={styles.title}>
          Are you going?
        </Text>
        {own.map(row => (
          <View key={row.userId}>
            <View style={styles.replyRow}>
              <Emblem
                uri={row.avatarUrl}
                fallback={initialsOf(row.name)}
                shape="circle"
                size={2}
              />
              <Text style={styles.replyName}>{row.name}</Text>
              <View style={styles.replyControl}>
                <EventRsvpPill
                  userId={row.userId}
                  name={row.name}
                  value={row.response}
                  disabled={busy[row.userId]}
                  onChange={response => {
                    change(row.userId, response).catch(() => undefined)
                  }}
                />
              </View>
            </View>
            {replyErrors[row.userId] != null &&
              replyErrors[row.userId] !== '' && (
                <Text accessibilityRole="alert" style={styles.error}>
                  {replyErrors[row.userId]}
                </Text>
              )}
          </View>
        ))}
      </Card>
      {error !== '' && (
        <>
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
          <Button
            label="Retry attendance"
            kind="secondary"
            onPress={() => {
              refresh().catch(() => undefined)
            }}
          />
        </>
      )}
      {RSVP_ORDER.map((response, index) => {
        const rows = info.attendees.filter(row => row.response === response)
        return (
          <View
            key={index}
            testID={`attendance-${response ?? 'noReply'}`}
            style={styles.group}
          >
            <Text accessibilityRole="header" style={styles.groupTitle}>
              {RSVP_LABELS[index]} · {rows.length}
            </Text>
            {rows.length === 0 ? (
              <Text style={styles.detail}>No one yet</Text>
            ) : (
              rows.map(row => (
                <View key={row.userId} style={styles.person}>
                  <Emblem
                    uri={row.avatarUrl}
                    fallback={initialsOf(row.name)}
                    shape="circle"
                    size={1.75}
                  />
                  <Text style={styles.name}>{row.name}</Text>
                </View>
              ))
            )}
          </View>
        )
      })}
      {info.canManage && (
        <Button
          label="Edit event details"
          kind="secondary"
          onPress={() => {
            setEditing(true)
          }}
        />
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  section: {
    gap: theme.rem(1),
    padding: theme.rem(1),
    width: '100%',
    maxWidth: theme.rem(50),
    alignSelf: 'center',
    paddingBottom: theme.rem(6)
  },
  detail: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  name: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    color: theme.primaryTextColor,
    flexShrink: 1
  },
  title: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.25),
    color: theme.primaryTextColor
  },
  location: { padding: theme.rem(0.75), gap: theme.rem(0.75) },
  addressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(0.75)
  },
  addressText: { flex: 1 },
  chevron: {
    minWidth: theme.rem(2.75),
    minHeight: theme.rem(2.75),
    alignItems: 'center',
    justifyContent: 'center'
  },
  attendance: { padding: theme.rem(1), gap: theme.rem(1) },
  replyRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.rem(0.5)
  },
  replyName: {
    flex: 1,
    minWidth: theme.rem(3),
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  },
  replyControl: { marginLeft: 'auto', maxWidth: '100%' },
  group: { gap: theme.rem(0.75), paddingHorizontal: theme.rem(0.5) },
  groupTitle: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  },
  person: { flexDirection: 'row', alignItems: 'center', gap: theme.rem(0.75) },
  error: {
    fontFamily: theme.regularTextFont,
    color: theme.dangerColor,
    fontSize: theme.rem(0.875)
  }
}))
