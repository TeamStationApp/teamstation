import React, { useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import { scheduleDate } from '../screens/format'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Badge, type BadgeTone } from './Badge'
import { SideCamera } from './SideCamera'

/** Wide enough for the widest month and two-digit day, with iOS's wider digits. */
export const SCHEDULE_DATE_WIDTH_REM = 3.25

export interface ScheduleRowProps {
  /**
   * The away team, or the team whose page this is. On that team's own page
   * it is the only line, and it is the opponent: `@ Bay Stars`.
   */
  first: string
  /**
   * `@ Bay Stars` or `vs Cyclones`. Left out on a team's own page, where the
   * row has one line and repeating the team's name on every game says nothing.
   */
  second?: string
  startAt: string | null
  venue?: string | null
  status: string
  pendingApproval?: boolean
  cancellationReason?: string | null
  withdrawnByTeamName?: string | null
  awayScore: number | null
  homeScore: number | null
  /**
   * A camera is publishing. That is not the same as the game being scored,
   * and it does not draw the LIVE pill.
   */
  // eslint-disable-next-line react/no-unused-prop-types -- accepted and ignored
  isLive?: boolean
  videoCount: number
  /**
   * The finished game's badge, written from one side: a team's own page reads
   * `W 5–3` ours first, where a one-line row has no away team written first
   * to say which score is whose. LIVE still takes its place while scored.
   */
  result?: { label: string; tone: BadgeTone }
  onPress?: () => void
}

/**
 * One game on a schedule.
 *
 * The weekday sits above a separator and the month/day. The time belongs
 * to the event details, and a recorded game keeps a small
 * camera at the bottom right. LIVE is a game being scored, where the score
 * would have been.
 */
export function ScheduleRow(props: ScheduleRowProps): React.ReactElement {
  const {
    first,
    second,
    startAt,
    venue,
    status,
    awayScore,
    homeScore,
    videoCount,
    result,
    onPress,
    pendingApproval = false,
    cancellationReason,
    withdrawnByTeamName
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const dated = scheduleDate(startAt)
  const [detailsHeight, setDetailsHeight] = useState(0)
  // The 1.125rem weekday, the 1.5rem month, the 2.4rem day, 1rem separator
  // spacing and its 3px rule.
  const calendarHeight =
    dated.weekday === '' ? theme.rem(1.5) : theme.rem(6.025) + 3
  const scale =
    detailsHeight > 0 ? Math.min(1, detailsHeight / calendarHeight) : 1
  const inProgress = status === 'inProgress'
  const scored = awayScore != null && homeScore != null && !inProgress
  const cancelled = status === 'cancelled'
  const badgeLabel = pendingApproval
    ? 'Pending approval'
    : cancelled
      ? 'Canceled'
      : inProgress
        ? 'LIVE'
        : result != null
          ? result.label
          : scored
            ? `${awayScore}\u2013${homeScore}`
            : undefined
  const badgeTone: BadgeTone =
    pendingApproval || cancelled
      ? 'neutral'
      : inProgress
        ? 'live'
        : (result?.tone ?? 'neutral')
  const teams = second == null ? first : `${first} ${second}`

  const calendar = (
    <View
      style={[
        styles.date,
        { width: theme.rem(SCHEDULE_DATE_WIDTH_REM) * scale }
      ]}
      testID="schedule-date"
    >
      {dated.weekday !== '' && (
        <>
          <Text
            style={[
              styles.month,
              {
                fontSize: theme.rem(0.9375) * scale,
                lineHeight: theme.rem(1.125) * scale
              }
            ]}
            numberOfLines={1}
            testID="schedule-weekday"
          >
            {dated.weekday}
          </Text>
          <View
            style={[
              styles.dateSeparator,
              { height: 3 * scale, marginVertical: theme.rem(0.5) * scale }
            ]}
            testID="schedule-date-separator"
          />
        </>
      )}
      <Text
        style={[
          styles.month,
          {
            fontSize: theme.rem(1.25) * scale,
            lineHeight: theme.rem(1.5) * scale
          }
        ]}
        numberOfLines={1}
      >
        {dated.month}
      </Text>
      {dated.day !== '' && (
        <Text
          style={[
            styles.day,
            {
              fontSize: theme.rem(2) * scale,
              lineHeight: theme.rem(2.4) * scale
            }
          ]}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.75}
        >
          {dated.day}
        </Text>
      )}
    </View>
  )
  const details = (
    <View
      style={styles.details}
      testID="schedule-details"
      onLayout={event => {
        const height = event.nativeEvent.layout.height
        if (height > 0)
          setDetailsHeight(held =>
            Math.abs(held - height) < 0.1 ? held : height
          )
      }}
    >
      <View style={styles.first}>
        <Text style={[styles.team, styles.firstName]} numberOfLines={1}>
          {first}
        </Text>
        {badgeLabel != null && <Badge label={badgeLabel} tone={badgeTone} />}
      </View>
      {second != null && (
        <Text style={styles.team} numberOfLines={1}>
          {second}
        </Text>
      )}
      {dated.when !== '' && (
        <Text style={styles.detail} numberOfLines={1}>
          {dated.time}
        </Text>
      )}
      {venue != null && venue !== '' && (
        <Text style={styles.venue} numberOfLines={1}>
          {venue}
        </Text>
      )}
      {status === 'cancelled' && cancellationReason === 'withdrawal' && (
        <Text style={styles.detail}>
          Withdrawal — {withdrawnByTeamName ?? 'A team'} withdrew
        </Text>
      )}
    </View>
  )
  const camera =
    videoCount > 0 ? (
      <View style={styles.camera} pointerEvents="none">
        <SideCamera />
      </View>
    ) : null
  const label = `${teams}, ${dated.when}${pendingApproval ? ', Pending approval' : ''}`
  const content = (
    <>
      {calendar}
      <View style={styles.text}>{details}</View>
      {camera}
    </>
  )

  if (onPress == null)
    return (
      <View style={styles.row} testID="schedule-display-row">
        {content}
      </View>
    )

  return (
    <Pressable
      accessibilityRole="button"
      testID="schedule-display-row"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      {content}
    </Pressable>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.rem(theme.cardContentInsetRem),
    position: 'relative'
  },
  pressed: {
    backgroundColor: theme.highlightRowActiveBackground
  },
  date: {
    width: theme.rem(SCHEDULE_DATE_WIDTH_REM),
    alignItems: 'center'
  },
  month: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.25),
    fontWeight: '600',
    color: theme.secondaryTextColor
  },
  dateSeparator: {
    width: '100%',
    height: 3,
    backgroundColor: theme.defaultBorderColor,
    marginVertical: theme.rem(0.5)
  },
  day: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(2),
    fontWeight: '700',
    color: theme.primaryTextColor
  },
  text: {
    flex: 1,
    minWidth: 0
  },
  details: {
    gap: theme.rem(0.0625)
  },
  first: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem)
  },
  firstName: {
    flex: 1,
    minWidth: 0
  },
  team: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  detail: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  venue: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.75),
    color: theme.secondaryTextColor,
    opacity: 0.8
  },
  camera: {
    position: 'absolute',
    right: 0,
    bottom: 0
  }
}))
