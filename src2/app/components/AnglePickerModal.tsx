import React, { useState } from 'react'
import { Modal, Pressable, ScrollView, Text, View } from 'react-native'

import type { VideoSummary } from '../../common/api'
import { lstrings } from '../locales/strings'
import {
  type AngleCandidate,
  angleLabels,
  defaultAngles,
  MAX_ANGLES
} from '../player/multiCam/takes'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'
import { VideoPoster } from './VideoPoster'

export interface AnglePickerModalProps {
  videos: VideoSummary[]
  /** What is ticked when it opens, where the address already named some. */
  chosen?: string[]
  onWatch: (videoIds: string[]) => void
  onClose: () => void
}

const candidateOf = (video: VideoSummary): AngleCandidate => ({
  id: video.id,
  title: video.title,
  status: video.status,
  numCameras: video.numCameras,
  durationSec: video.durationSec
})

/**
 * Choosing the four.
 *
 * Ticks rather than a drag-and-drop arrangement: the arrangement is made in
 * the view itself, by moving the pictures, where somebody can see what they
 * are arranging. Here the only question is which cameras.
 *
 * The cap says why it is a cap rather than going quietly dead, because a tick
 * that stops working without explanation reads as a broken page.
 */
export function AnglePickerModal(
  props: AnglePickerModalProps
): React.ReactElement {
  const { videos, chosen, onWatch, onClose } = props
  const theme = useTheme()
  const styles = getStyles(theme)

  const candidates = videos.map(candidateOf)
  const labels = new Map(angleLabels(candidates).map(one => [one.id, one]))
  const [picked, setPicked] = useState<string[]>(
    chosen != null && chosen.length > 0
      ? chosen.slice(0, MAX_ANGLES)
      : defaultAngles(candidates)
  )
  const full = picked.length >= MAX_ANGLES

  const toggle = (id: string): void => {
    setPicked(current =>
      current.includes(id)
        ? current.filter(one => one !== id)
        : current.length >= MAX_ANGLES
          ? current
          : [...current, id]
    )
  }

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <View style={styles.scrim}>
        {/* A sibling of the sheet, never its parent: a pressable inside a
            pressable is invalid on the web build. */}
        <Pressable
          style={styles.behind}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={lstrings.angles_cancel}
        />
        <View style={styles.sheet}>
          <Text style={styles.title}>{lstrings.angles_title}</Text>
          <Text style={styles.detail}>{lstrings.angles_detail}</Text>

          <ScrollView style={styles.list}>
            {videos.map(video => {
              const label = labels.get(video.id)
              const on = picked.includes(video.id)
              const gone = video.status !== 'ready' && video.status !== 'live'
              // A full picker leaves the ticked ones pressable, so somebody can
              // always swap one for another without first working out that they
              // have to untick something.
              const disabled = gone || (full && !on)
              const name =
                label?.mosaic === true
                  ? lstrings.video_multi_angle
                  : (label?.name ?? video.title)
              return (
                <Pressable
                  key={video.id}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on, disabled }}
                  // react-native-web renders `aria-disabled` from the state
                  // above but not `aria-checked`, and a checkbox that never
                  // says whether it is checked is a checkbox a screen reader
                  // cannot read. Passed through as well, in the one place that
                  // has a checkbox at all.
                  aria-checked={on}
                  accessibilityLabel={name}
                  style={[styles.row, on && styles.rowOn]}
                  disabled={disabled}
                  onPress={() => {
                    toggle(video.id)
                  }}
                >
                  <Text style={[styles.mark, disabled && styles.markOff]}>
                    {on ? '◉' : '○'}
                  </Text>
                  <View style={styles.thumb}>
                    <VideoPoster uri={video.posterUrl ?? null} />
                  </View>
                  <View style={styles.rowText}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {/* A mosaic is named for what it is rather than for the
                          word on the end of its title, which is `raw`. */}
                      {name}
                    </Text>
                    <Text style={styles.rowDetail} numberOfLines={1}>
                      {gone
                        ? lstrings.game_video_gone_suffix
                        : lengthOf(video.durationSec)}
                    </Text>
                  </View>
                </Pressable>
              )
            })}
          </ScrollView>

          {full ? <Text style={styles.cap}>{lstrings.angles_cap}</Text> : null}

          <View style={styles.buttons}>
            <Button
              label={lstrings.angles_cancel}
              kind="text"
              onPress={onClose}
            />
            <Button
              label={lstrings.angles_watch}
              disabled={picked.length === 0}
              onPress={() => {
                onWatch(picked)
              }}
            />
          </View>
        </View>
      </View>
    </Modal>
  )
}

/** `1:38:32`, or nothing at all for a stream that has not finished. */
function lengthOf(durationSec: number | null): string {
  if (durationSec == null) return ''
  const total = Math.round(durationSec)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`
}

const getStyles = cacheStyles((theme: Theme) => ({
  scrim: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.overlayBackgroundColor,
    padding: theme.rem(theme.spaceMdRem)
  },
  behind: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0
  },
  sheet: {
    width: '100%',
    maxWidth: theme.rem(26),
    maxHeight: '86%',
    padding: theme.rem(theme.spaceMdRem),
    borderRadius: theme.rem(theme.radiusRem),
    backgroundColor: theme.cardBackgroundColor
  },
  title: {
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.125),
    fontWeight: '600'
  },
  detail: {
    color: theme.secondaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    marginTop: theme.rem(theme.spaceXsRem)
  },
  list: {
    marginTop: theme.rem(theme.spaceSmRem)
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: theme.rem(3),
    paddingVertical: theme.rem(theme.spaceXsRem),
    paddingHorizontal: theme.rem(theme.spaceSmRem),
    borderRadius: theme.rem(theme.radiusRem),
    gap: theme.rem(theme.spaceSmRem)
  },
  rowOn: {
    backgroundColor: theme.inactiveBackgroundColor
  },
  mark: {
    color: theme.activeColor,
    fontSize: theme.rem(1)
  },
  markOff: {
    color: theme.placeholderTextColor
  },
  thumb: {
    width: theme.rem(5),
    aspectRatio: 16 / 9,
    borderRadius: theme.rem(0.375),
    overflow: 'hidden'
  },
  rowText: {
    flex: 1
  },
  rowName: {
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    fontWeight: '600'
  },
  rowDetail: {
    color: theme.secondaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.75)
  },
  cap: {
    color: theme.secondaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.75),
    marginTop: theme.rem(theme.spaceXsRem)
  },
  buttons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem),
    marginTop: theme.rem(theme.spaceSmRem)
  }
}))
