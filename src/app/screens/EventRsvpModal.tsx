import React, { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View
} from 'react-native'

import type { GameSummary, TeamStationClient } from '../../common/api'
import {
  type EventAttendee,
  type EventInfo,
  eventName,
  type PlayerRsvpCounts,
  playerRsvpCounts,
  type Rsvp
} from '../../common/eventInfo'
import { eventLocalRange } from '../../common/eventTime'
import { Button, Card, Emblem, initialsOf } from '../components'
import { EventRsvpPill } from '../components/EventRsvpPill'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export function eventReplyRows(infos: EventInfo[]): EventAttendee[] {
  const primary = infos[0]
  if (primary == null) return []
  // The server applies the same eligibility policy to reads and writes,
  // including children on the other participating team and merged identities.
  return primary.replyUserIds.flatMap(id =>
    primary.attendees.filter(row => row.userId === id && row.canReply)
  )
}
export async function loadEventReplyInfos(
  client: TeamStationClient,
  eventId: string,
  teamId: string
): Promise<EventInfo[]> {
  return [await client.eventInfo(eventId, teamId)]
}
/** What the modal needs of a game or event: its id and how to name it. */
export type RsvpEvent = Pick<
  GameSummary,
  | 'id'
  | 'homeTeamId'
  | 'homeTeamName'
  | 'awayTeamName'
  | 'eventKind'
  | 'eventType'
  | 'title'
>
export function EventRsvpModal({
  client,
  game,
  teamId,
  onClose,
  onCounts,
  onReplies
}: {
  client: TeamStationClient
  game: RsvpEvent
  teamId: string
  onClose: () => void
  onCounts: (counts: PlayerRsvpCounts) => void
  onReplies?: (rows: EventAttendee[]) => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [infos, setInfos] = useState<EventInfo[]>([])
  const current = useRef<EventInfo[]>([])
  const alive = useRef(true)
  const writing = useRef(new Set<string>())
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [loadError, setLoadError] = useState('')
  const [retry, setRetry] = useState(0)
  const countsCallback = useRef(onCounts)
  countsCallback.current = onCounts
  const repliesCallback = useRef(onReplies)
  repliesCallback.current = onReplies
  useEffect(() => {
    let active = true
    alive.current = true
    setInfos([])
    setLoadError('')
    const load = async (): Promise<void> => {
      const found = await loadEventReplyInfos(client, game.id, teamId)
      if (!active) return
      current.current = found
      setInfos(current.current)
      countsCallback.current(playerRsvpCounts(found[0].attendees))
      repliesCallback.current?.(eventReplyRows(found))
    }
    load().catch((error: unknown) => {
      if (active)
        setLoadError(
          error instanceof Error ? error.message : 'RSVPs could not load.'
        )
    })
    return () => {
      active = false
      alive.current = false
    }
  }, [client, game.id, teamId, retry])
  const update = (id: string, response: Rsvp | null): void => {
    current.current = current.current.map(info => ({
      ...info,
      attendees: info.attendees.map(row =>
        row.userId === id ? { ...row, response } : row
      )
    }))
    if (alive.current) setInfos(current.current)
    if (current.current[0] != null)
      countsCallback.current(playerRsvpCounts(current.current[0].attendees))
  }
  const change = async (id: string, response: Rsvp): Promise<void> => {
    if (writing.current.has(id)) return
    const previous =
      current.current[0]?.attendees.find(row => row.userId === id)?.response ??
      null
    writing.current.add(id)
    setBusy(value => ({ ...value, [id]: true }))
    setErrors(value => ({ ...value, [id]: '' }))
    update(id, response)
    try {
      await client.saveRsvp(game.id, id, response)
    } catch (error) {
      update(id, previous)
      if (alive.current)
        setErrors(value => ({
          ...value,
          [id]:
            error instanceof Error
              ? error.message
              : 'RSVP could not save. Try again.'
        }))
    } finally {
      writing.current.delete(id)
      if (alive.current) setBusy(value => ({ ...value, [id]: false }))
      if (writing.current.size === 0 && alive.current)
        repliesCallback.current?.(eventReplyRows(current.current))
    }
  }
  const info = infos[0]
  const title =
    eventName(game) ??
    (game.homeTeamId === teamId
      ? `vs ${game.awayTeamName}`
      : `at ${game.homeTeamName}`)
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      <View style={styles.scrim}>
        <Pressable
          style={styles.behind}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close RSVP"
        />
        <View style={styles.sheet} testID="event-rsvp-modal">
          <ScrollView>
            <Text style={styles.title}>{title}</Text>
            {info?.startAt != null && (
              <Text style={styles.detail}>
                {eventLocalRange(info.startAt, info.endAt)}
              </Text>
            )}
            {info?.venue != null && (
              <Text selectable style={styles.detail}>
                {info.venue}
              </Text>
            )}
            {info?.address != null && info.address !== info.venue && (
              <Text selectable style={styles.detail}>
                {info.address}
              </Text>
            )}
            {info == null ? (
              loadError === '' ? (
                <ActivityIndicator accessibilityLabel="Loading RSVPs" />
              ) : (
                <>
                  <Text accessibilityRole="alert" style={styles.error}>
                    {loadError}
                  </Text>
                  <Button
                    label="Retry RSVPs"
                    onPress={() => {
                      setRetry(value => value + 1)
                    }}
                  />
                </>
              )
            ) : (
              <Card style={styles.people}>
                {eventReplyRows(infos).map((row, index) => (
                  <View
                    key={row.userId}
                    style={[styles.person, index > 0 && styles.divider]}
                    testID={`quick-rsvp-row-${row.userId}`}
                  >
                    <View style={styles.line}>
                      <Emblem
                        uri={row.avatarUrl}
                        fallback={initialsOf(row.name)}
                        shape="circle"
                        size={2}
                      />
                      <Text style={styles.name}>{row.name}</Text>
                      <View style={styles.control}>
                        <EventRsvpPill
                          userId={row.userId}
                          name={row.name}
                          value={row.response}
                          widthRem={16.5}
                          oneLineLabels
                          boldLabels
                          disabled={busy[row.userId]}
                          onChange={response => {
                            change(row.userId, response).catch(() => undefined)
                          }}
                        />
                      </View>
                    </View>
                    {errors[row.userId] != null &&
                      errors[row.userId] !== '' && (
                        <Text accessibilityRole="alert" style={styles.error}>
                          {errors[row.userId]}
                        </Text>
                      )}
                  </View>
                ))}
              </Card>
            )}
          </ScrollView>
          <Button label="Done" kind="secondary" onPress={onClose} />
        </View>
      </View>
    </Modal>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  scrim: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: theme.overlayBackgroundColor,
    padding: theme.rem(1)
  },
  behind: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 },
  sheet: {
    width: '100%',
    maxWidth: theme.rem(34),
    maxHeight: '90%' as const,
    backgroundColor: theme.cardBackgroundColor,
    borderRadius: theme.rem(1),
    padding: theme.rem(1),
    gap: theme.rem(0.75)
  },
  // Every line here is bold, so the sheet reads at a glance.
  title: {
    color: theme.primaryTextColor,
    fontFamily: theme.boldTextFont,
    fontWeight: '700',
    fontSize: theme.rem(1.25),
    marginBottom: theme.rem(0.5)
  },
  detail: {
    color: theme.secondaryTextColor,
    fontFamily: theme.boldTextFont,
    fontWeight: '700',
    fontSize: theme.rem(0.875),
    marginBottom: theme.rem(0.5)
  },
  people: { padding: theme.rem(0.5), marginTop: theme.rem(0.75) },
  person: { paddingVertical: theme.rem(0.5) },
  line: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.rem(0.5),
    alignItems: 'center'
  },
  divider: { borderTopWidth: 1, borderTopColor: theme.defaultBorderColor },
  name: {
    flex: 1,
    minWidth: theme.rem(3),
    color: theme.primaryTextColor,
    fontFamily: theme.boldTextFont,
    fontWeight: '700',
    fontSize: theme.rem(1)
  },
  control: { marginLeft: 'auto', maxWidth: '100%' as const },
  error: {
    color: theme.dangerColor,
    fontFamily: theme.boldTextFont,
    fontWeight: '700',
    fontSize: theme.rem(0.875)
  }
}))
