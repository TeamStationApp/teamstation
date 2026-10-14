import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import type { GameSummary, TeamStationClient } from '../../common/api'
import { type EventAttendee, playerRsvpCounts } from '../../common/eventInfo'
import { Emblem, initialsOf } from '../components'
import { RSVP_COLORS } from '../components/eventRsvpPosition'
import { PlayerRsvpCounts } from '../components/PlayerRsvpCounts'
import { useForegroundRefresh } from '../hooks/useForegroundRefresh'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import {
  eventReplyRows,
  EventRsvpModal,
  loadEventReplyInfos
} from './EventRsvpModal'

export function canScheduleRsvp(game: GameSummary, now = Date.now()): boolean {
  return (
    !game.pendingApproval &&
    game.status === 'scheduled' &&
    game.startAt != null &&
    Date.parse(game.startAt) > now
  )
}

/**
 * Whether a schedule card has an RSVP line to draw: the RSVP button while
 * the event is still to come, or any players' replies to count.
 */
export function hasScheduleRsvpLine(
  game: GameSummary,
  now = Date.now()
): boolean {
  const counts = game.playerRsvps
  return (
    counts != null &&
    (canScheduleRsvp(game, now) || counts.yes + counts.unknown + counts.no > 0)
  )
}

/** The schedule's compact family response entry and player totals. */
export function ScheduleRsvpControl({
  client,
  game,
  teamId,
  label
}: {
  client: TeamStationClient
  game: GameSummary
  teamId: string
  label: string
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const avatarDiameter = theme.rem(1.5) + 8
  const [now, setNow] = useState(Date.now)
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<EventAttendee[]>([])
  const [counts, setCounts] = useState(game.playerRsvps!)
  const generation = useRef(0)
  const modalVisit = useRef(0)
  const visit = modalVisit.current
  useEffect(() => {
    if (!canScheduleRsvp(game)) return
    let timer: ReturnType<typeof setTimeout>
    const tick = (): void => {
      const untilStart = Date.parse(game.startAt!) - Date.now()
      if (untilStart > 0) {
        timer = setTimeout(tick, Math.min(untilStart, 2147483647))
      } else {
        modalVisit.current++
        generation.current++
        setOpen(false)
        setNow(Date.now())
      }
    }
    tick()
    return () => {
      clearTimeout(timer)
    }
  }, [game])
  useEffect(
    () => () => {
      generation.current++
    },
    [client, game.id, teamId]
  )
  const refresh = useCallback(async (): Promise<void> => {
    setNow(Date.now())
    if (open || !canScheduleRsvp(game)) return
    const request = ++generation.current
    try {
      const infos = await loadEventReplyInfos(client, game.id, teamId)
      if (request === generation.current) {
        setRows(eventReplyRows(infos))
        setCounts(playerRsvpCounts(infos[0].attendees))
      }
    } catch {
      // Keep the entry available: the modal offers an explicit load retry.
    }
  }, [client, game, teamId, open])
  useForegroundRefresh(refresh)
  const upcoming = canScheduleRsvp(game, now)
  const responded = rows.some(row => row.response != null)
  return (
    <View style={styles.footer} testID={`schedule-rsvps-${game.id}`}>
      {upcoming && (
        <Pressable
          testID={`schedule-rsvp-control-${game.id}`}
          accessibilityRole="button"
          hitSlop={8}
          accessibilityLabel={`RSVP: ${label}`}
          accessibilityHint={
            responded
              ? rows
                  .map(
                    row =>
                      `${row.name}: ${row.response === 'yes' ? 'Yes' : row.response === 'no' ? 'No' : row.response === 'maybe' ? 'Maybe' : 'No reply'}`
                  )
                  .join(', ')
              : 'Respond for yourself and your players'
          }
          onPress={() => {
            generation.current++
            modalVisit.current++
            setOpen(true)
          }}
          style={styles.target}
        >
          {responded ? (
            <View style={styles.avatars} testID="schedule-rsvp-avatars">
              {rows.map(row => (
                <View
                  key={row.userId}
                  testID={`schedule-rsvp-avatar-${row.userId}`}
                  style={[
                    styles.avatar,
                    {
                      borderColor:
                        RSVP_COLORS[
                          row.response === 'yes'
                            ? 0
                            : row.response === 'no'
                              ? 2
                              : 1
                        ]
                    }
                  ]}
                >
                  <Emblem
                    uri={row.avatarUrl}
                    fallback={initialsOf(row.name)}
                    shape="circle"
                    size={1.5}
                  />
                </View>
              ))}
            </View>
          ) : (
            <View
              style={[styles.button, { height: avatarDiameter }]}
              testID="schedule-rsvp-button"
            >
              <Text style={styles.label}>RSVP</Text>
            </View>
          )}
        </Pressable>
      )}
      <View style={styles.counts}>
        <PlayerRsvpCounts counts={counts} diameter={avatarDiameter} />
      </View>
      {open && upcoming && (
        <EventRsvpModal
          client={client}
          game={game}
          teamId={teamId}
          onClose={() => {
            modalVisit.current++
            setOpen(false)
          }}
          onCounts={value => {
            if (visit === modalVisit.current) setCounts(value)
          }}
          onReplies={value => {
            if (visit === modalVisit.current) setRows(value)
          }}
        />
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.rem(0.5),
    marginTop: theme.rem(0.5)
  },
  target: {
    minHeight: theme.rem(2.75),
    justifyContent: 'center',
    flexShrink: 1
  },
  button: {
    borderRadius: theme.radiusPill,
    backgroundColor: RSVP_COLORS[1],
    paddingHorizontal: theme.rem(0.5),
    paddingVertical: theme.rem(0.1875),
    justifyContent: 'center',
    alignSelf: 'flex-start'
  },
  label: {
    color: '#ffffff',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.8125)
  },
  avatars: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.rem(0.375),
    paddingVertical: theme.rem(0.375)
  },
  avatar: { borderRadius: theme.radiusPill, borderWidth: 2, padding: 2 },
  counts: { marginLeft: 'auto' }
}))
