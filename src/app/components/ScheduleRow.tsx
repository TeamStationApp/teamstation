import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { scheduleDate } from '../screens/format'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Badge, type BadgeTone } from './Badge'
import { SideCamera } from './SideCamera'

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
 * The thumbnail is gone. The month sits over the day, the weekday and the
 * time take the line the date used to, and a recorded game keeps a small
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
    onPress
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const dated = scheduleDate(startAt)
  const inProgress = status === 'inProgress'
  const scored = awayScore != null && homeScore != null && !inProgress
  const badgeLabel = inProgress
    ? 'LIVE'
    : result != null
      ? result.label
      : scored
        ? `${awayScore}\u2013${homeScore}`
        : undefined
  const badgeTone: BadgeTone = inProgress ? 'live' : (result?.tone ?? 'neutral')
  const teams = second == null ? first : `${first} ${second}`

  const content = (
    <>
      <View style={styles.date}>
        <Text style={styles.month}>{dated.month}</Text>
        <Text style={styles.day}>{dated.day}</Text>
      </View>
      <View style={styles.text}>
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
            {dated.when}
          </Text>
        )}
        {venue != null && venue !== '' && (
          <Text style={styles.venue} numberOfLines={1}>
            {venue}
          </Text>
        )}
      </View>
      {videoCount > 0 && (
        <View style={styles.camera} pointerEvents="none">
          <SideCamera />
        </View>
      )}
    </>
  )

  if (onPress == null) return <View style={styles.row}>{content}</View>

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${teams}, ${dated.when}`}
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
    gap: theme.rem(theme.spaceSmRem),
    position: 'relative'
  },
  pressed: {
    backgroundColor: theme.highlightRowActiveBackground
  },
  date: {
    width: theme.rem(2.75),
    alignItems: 'center'
  },
  month: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    fontWeight: '600',
    color: theme.secondaryTextColor
  },
  day: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.25),
    fontWeight: '700',
    color: theme.primaryTextColor
  },
  text: {
    flex: 1,
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
