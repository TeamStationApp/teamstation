import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import {
  type EventInfo,
  type EventLocation,
  playerRsvpCounts,
  type Rsvp,
  sortedAttendees
} from '../../common/eventInfo'
import {
  Button,
  Card,
  Emblem,
  Icon,
  initialsOf,
  ListRow,
  SectionHeader
} from '../components'
import { EventMap } from '../components/EventMap'
import { EventRsvpPill } from '../components/EventRsvpPill'
import { PlayerRsvpCounts } from '../components/PlayerRsvpCounts'
import { SegmentedPill } from '../components/SegmentedPill'
import { useForegroundRefresh } from '../hooks/useForegroundRefresh'
import {
  copyEventAddress,
  openEventDirections
} from '../platform/eventDirections'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { attendanceSections, attendanceSubtitle } from './eventAttendance'

export function EventInfoTab({
  client,
  eventId,
  onLoaded
}: {
  client: TeamStationClient
  eventId: string
  onLoaded?: (info: EventInfo) => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [info, setInfo] = useState<EventInfo>()
  const [error, setError] = useState('')
  const [selectedTeam, setSelectedTeam] = useState<string>()
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
      const found = await client.eventInfo(eventId, selectedTeam)
      if (
        live.current &&
        request === generation.current &&
        writes.current.size === 0
      ) {
        setInfo(found)
        onLoaded?.(found)
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
  }, [client, eventId, selectedTeam, onLoaded])
  const latestRefresh = useRef({ refresh, selectedTeam, teamId: info?.teamId })
  latestRefresh.current = { refresh, selectedTeam, teamId: info?.teamId }
  useForegroundRefresh(refresh)
  const address =
    info?.address?.trim() !== '' && info?.address != null
      ? info.address
      : info?.venue
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
      const pendingTeam = latestRefresh.current
      if (
        live.current &&
        writes.current.size === 0 &&
        pendingTeam.selectedTeam != null &&
        pendingTeam.selectedTeam !== pendingTeam.teamId
      )
        pendingTeam.refresh().catch(() => undefined)
    }
  }
  const directions = (): void => {
    if (address == null) return
    const venueOnly = (info?.address?.trim() ?? '') === ''
    if (venueOnly && location == null) return
    const destination = venueOnly
      ? `${location!.latitude},${location!.longitude}`
      : address
    setNotice('')
    openEventDirections(destination).catch((error: unknown) => {
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
  const own = info.replyUserIds.flatMap(id =>
    info.attendees.filter(row => row.userId === id && row.canReply)
  )
  const teams = (info.attendanceTeams ?? []).filter(
    team => team.isParticipant === true
  )
  return (
    <View style={styles.section} testID="event-info">
      {notice !== '' && (
        <Text accessibilityLiveRegion="polite" style={styles.detail}>
          {notice}
        </Text>
      )}
      {info.canViewAttendance && (
        <View style={styles.replySection}>
          <View accessibilityRole="header" style={styles.replyHeader}>
            <SectionHeader title="Are you going?" />
            <PlayerRsvpCounts counts={playerRsvpCounts(info.attendees)} />
          </View>
          <Card style={styles.attendance} testID="event-replies">
            {own.map((row, index) => (
              <View
                key={row.userId}
                style={[styles.replyItem, index > 0 && styles.replyDivider]}
                testID={`event-reply-row-${row.userId}`}
              >
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
        </View>
      )}
      {address != null && address.trim() !== '' && (
        <>
          <Card style={styles.location} testID="event-location">
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
            <Pressable
              testID="event-directions"
              accessibilityRole="button"
              accessibilityLabel={
                (info.address?.trim() ?? '') === '' && location == null
                  ? 'Directions unavailable'
                  : 'Open directions'
              }
              accessibilityHint="Long press to copy the address"
              onPress={directions}
              onLongPress={copy}
              delayLongPress={450}
              style={styles.addressRow}
            >
              <View style={styles.addressText}>
                {info.venue != null && info.venue !== address && (
                  <Text style={styles.name}>{info.venue}</Text>
                )}
                <View testID="event-address">
                  <Text selectable style={styles.name}>
                    {address}
                  </Text>
                </View>
              </View>
              <View style={styles.chevron} pointerEvents="none">
                <Icon
                  name="chevron_right"
                  size={1.5}
                  color={theme.primaryTextColor}
                />
              </View>
            </Pressable>
            {info.notes != null && info.notes !== '' && (
              <Text selectable testID="event-notes" style={styles.detail}>
                {info.notes}
              </Text>
            )}
          </Card>
        </>
      )}
      {(address == null || address.trim() === '') && (
        <Card>
          <Text style={styles.detail}>Location not set</Text>
          {info.notes != null && info.notes !== '' && (
            <Text selectable testID="event-notes" style={styles.detail}>
              {info.notes}
            </Text>
          )}
        </Card>
      )}
      {info.canViewAttendance && teams.length === 2 && (
        <View style={styles.teamChoices} testID="event-attendance-teams">
          <View style={styles.teamPill}>
            <SegmentedPill
              options={[
                { id: teams[0].id, label: teams[0].name },
                { id: teams[1].id, label: teams[1].name }
              ]}
              selected={info.teamId}
              accessibilityLabel="RSVP teams"
              disabled={Object.values(busy).some(value => value)}
              onSelect={setSelectedTeam}
            />
          </View>
        </View>
      )}
      {!info.canViewAttendance && (
        <Text style={styles.detail}>
          Join a participating team to see RSVPs.
        </Text>
      )}
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
      {info.canViewAttendance &&
        attendanceSections(info.attendees)
          .filter(group => group.rows.length > 0)
          .map(group => (
            <View
              key={group.id}
              testID={`attendance-${group.id}`}
              style={styles.group}
            >
              <View accessibilityRole="header">
                <SectionHeader
                  title={group.title}
                  note={String(group.rows.length)}
                />
              </View>
              {group.rows.map(row => {
                const subtitle = attendanceSubtitle(
                  row,
                  group.id === 'staff-yes'
                )
                return (
                  <Card
                    flush
                    key={row.userId}
                    testID={`attendance-${group.id}-${row.userId}`}
                  >
                    <ListRow
                      title={row.name}
                      subtitleNumberOfLines={0}
                      subtitle={subtitle === '' ? undefined : subtitle}
                      emblem={initialsOf(row.name)}
                      emblemUri={row.avatarUrl}
                      emblemShape="circle"
                    />
                  </Card>
                )
              })}
            </View>
          ))}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  section: {
    gap: theme.rem(1),
    width: '100%',
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
  attendance: { padding: theme.rem(0.5) },
  replySection: { gap: theme.rem(0.375) },
  replyHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: theme.rem(0.5)
  },
  replyItem: { paddingVertical: theme.rem(0.5) },
  replyDivider: { borderTopWidth: 1, borderTopColor: theme.defaultBorderColor },
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
  group: { gap: theme.rem(0.75) },
  teamChoices: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: theme.rem(0.75)
  },
  teamPill: { flex: 1, minWidth: theme.rem(12), maxWidth: theme.rem(27) },
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
