import React from 'react'
import { Pressable, Text, View } from 'react-native'

import type { LiveStream } from '../../common/api'
import { Button } from '../components/Button'
import { Emblem } from '../components/Emblem'
import { Icon } from '../components/Icon'
import { initialsOf } from '../components/initials'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import {
  angleState,
  cameraSubtitle,
  type CameraTap,
  cameraTap,
  useCameraDuration
} from './cameraRowRules'

export interface CameraRowProps {
  stream: LiveStream
  mine: boolean
  /** This install's id, once it is known. */
  myId: string | undefined
  /** A line under the subtitle, for a recording held on another phone. */
  note?: string
  onTap: (tap: CameraTap) => void
  /** End, on an own phone row on another device. */
  onEnd?: () => void
  /** Delete, on an own ended row. */
  onDelete?: () => void
  /** The "…", where there is anything to offer behind it. */
  onMore?: () => void
}

/**
 * One camera on the Videos tab: who is filming it, its angle, what it is doing
 * and how long it has run. The row, its action and the "…" are separate
 * targets. The right column holds the chevron, or End where the row opens
 * nothing, with the duration beneath it.
 */
export function CameraRow(props: CameraRowProps): React.ReactElement {
  const { stream, mine, myId, note, onTap, onEnd, onDelete, onMore } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const duration = useCameraDuration(stream)
  const tap = cameraTap(stream, mine, myId)
  const opens = tap !== 'none'
  const state = angleState(stream)
  const press = (): void => {
    onTap(tap)
  }
  const foot =
    duration == null ? null : (
      <Text style={styles.duration} testID={`angle-duration-${stream.id}`}>
        {duration}
      </Text>
    )
  return (
    <View style={styles.row}>
      <Pressable
        style={styles.body}
        disabled={!opens}
        accessibilityRole={opens ? 'button' : undefined}
        testID={`angle-row-${stream.id}`}
        onPress={press}
      >
        {mine ? (
          <Emblem fallback="" icon="videocam" />
        ) : (
          <Emblem
            uri={stream.ownerPicture}
            fallback={initialsOf(stream.ownerName)}
            shape="circle"
          />
        )}
        <View style={styles.words}>
          <Text style={styles.name}>{stream.label}</Text>
          <Text style={styles.detail} testID={`angle-subtitle-${stream.id}`}>
            {cameraSubtitle(stream, mine)}
          </Text>
          {note != null && <Text style={styles.detail}>{note}</Text>}
        </View>
        <View
          style={[styles.chip, state === 'live' && styles.liveChip]}
          testID={`angle-state-${stream.id}`}
        >
          <Text
            style={[styles.chipText, state === 'live' && styles.liveChipText]}
          >
            {state === 'live'
              ? lstrings.stream_angle_live
              : state === 'ended'
                ? lstrings.stream_angle_ended
                : lstrings.stream_angle_idle}
          </Text>
        </View>
      </Pressable>
      {onMore != null && (
        <Pressable
          style={styles.more}
          accessibilityRole="button"
          accessibilityLabel={sprintf(lstrings.stream_angle_more, stream.label)}
          testID={`angle-more-${stream.id}`}
          onPress={onMore}
        >
          <Text style={styles.moreText}>…</Text>
        </Pressable>
      )}
      {onDelete != null && (
        <Button
          kind="text"
          compact
          label={lstrings.stream_row_delete}
          accessibilityLabel={sprintf(
            lstrings.stream_row_delete_label,
            stream.label
          )}
          textColor={theme.dangerColor}
          testID={`angle-delete-${stream.id}`}
          onPress={onDelete}
        />
      )}
      {opens ? (
        // The row's own target carries the words; this only reaches further.
        <Pressable accessible={false} style={styles.tail} onPress={press}>
          <Icon name="chevron_right" color={theme.secondaryTextColor} />
          {foot}
        </Pressable>
      ) : (
        <View style={styles.tail}>
          {onEnd != null && (
            <Button
              kind="text"
              compact
              label={lstrings.stream_row_end}
              accessibilityLabel={sprintf(
                lstrings.stream_row_end_label,
                stream.label
              )}
              textColor={theme.dangerColor}
              testID={`angle-end-${stream.id}`}
              onPress={onEnd}
            />
          )}
          {foot}
        </View>
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceXsRem),
    minHeight: theme.rem(3)
  },
  body: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(theme.spaceXsRem)
  },
  words: {
    flex: 1,
    gap: theme.rem(0.125)
  },
  name: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '700',
    color: theme.primaryTextColor
  },
  detail: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  chip: {
    paddingHorizontal: theme.rem(0.5),
    paddingVertical: theme.rem(0.125),
    borderRadius: theme.rem(0.75),
    backgroundColor: theme.inactiveBackgroundColor
  },
  liveChip: {
    backgroundColor: theme.liveColor
  },
  chipText: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    fontWeight: '600',
    color: theme.secondaryTextColor
  },
  liveChipText: {
    color: '#FFFFFF'
  },
  more: {
    minWidth: theme.rem(2.75),
    minHeight: theme.rem(2.75),
    alignItems: 'center',
    justifyContent: 'center'
  },
  moreText: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.25),
    fontWeight: '700',
    color: theme.primaryTextColor
  },
  // A column of its own, so every row's duration sits on one right edge.
  tail: {
    minWidth: theme.rem(2.75),
    minHeight: theme.rem(2.75),
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: theme.rem(0.125)
  },
  // Below the chevron and a little to its left.
  duration: {
    marginRight: theme.rem(0.25),
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    fontVariant: ['tabular-nums'],
    color: theme.secondaryTextColor
  }
}))
