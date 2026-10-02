import React, { useState } from 'react'
import { Modal, Pressable, ScrollView, Switch, Text, View } from 'react-native'

import type { VideoSummary } from '../../common/api'
import { lstrings, sprintf } from '../locales/strings'
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
  /** Which one is heard, where the address already named one. */
  audioId?: string | null
  onWatch: (videoIds: string[], audioId: string | null) => void
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
 * Choosing the four, and which one is heard.
 *
 * Four columns: the picture, its name, a switch that puts it in the grid, and
 * a radio for its sound. The sound is chosen here and nowhere else — the view
 * has no control for it, so a tap meant for the pictures cannot move it — and
 * starts on the first angle switched on, in the order of this list.
 *
 * Switches rather than a drag-and-drop arrangement: the arrangement is made in
 * the view itself, by moving the pictures, where somebody can see what they
 * are arranging. Here the only question is which cameras.
 *
 * The cap says why it is a cap rather than going quietly dead, because a tick
 * that stops working without explanation reads as a broken page.
 */
export function AnglePickerModal(
  props: AnglePickerModalProps
): React.ReactElement {
  const { videos, chosen, audioId, onWatch, onClose } = props
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
  const [heard, setHeard] = useState<string | null>(audioId ?? null)
  // The first angle switched on, in the list's order, wherever the one chosen
  // is not switched on (or nothing has been chosen).
  const firstOn = videos.find(video => picked.includes(video.id))?.id ?? null
  const audio = heard != null && picked.includes(heard) ? heard : firstOn

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

          <View style={styles.header}>
            <Text style={[styles.headerText, styles.headerAngle]}>
              {lstrings.angles_column_angle}
            </Text>
            <Text style={[styles.headerText, styles.headerShow]}>
              {lstrings.angles_column_show}
            </Text>
            <Text style={[styles.headerText, styles.headerSound]}>
              {lstrings.angles_column_sound}
            </Text>
          </View>

          <ScrollView style={styles.list}>
            {videos.map(video => {
              const label = labels.get(video.id)
              const on = picked.includes(video.id)
              const gone = video.status !== 'ready' && video.status !== 'live'
              // A full picker leaves the chosen ones switchable, so somebody
              // can always swap one for another without first working out that
              // they have to switch something off.
              const disabled = gone || (full && !on)
              const name =
                label?.mosaic === true
                  ? lstrings.video_multi_angle
                  : (label?.name ?? video.title)
              const isHeard = on && audio === video.id
              return (
                <View key={video.id} style={[styles.row, on && styles.rowOn]}>
                  {/* The picture and the name switch it too: a bigger target
                      than the switch alone. A sibling of the switch, never
                      its parent — a pressable inside a pressable is invalid
                      on the web build. */}
                  <Pressable
                    style={styles.rowMain}
                    disabled={disabled}
                    accessibilityElementsHidden
                    importantForAccessibility="no"
                    onPress={() => {
                      toggle(video.id)
                    }}
                  >
                    <View style={styles.thumb}>
                      <VideoPoster uri={video.posterUrl ?? null} />
                    </View>
                    <View style={styles.rowText}>
                      <Text style={styles.rowName} numberOfLines={1}>
                        {/* A mosaic is named for what it is rather than for
                            the word on the end of its title, which is `raw`. */}
                        {name}
                      </Text>
                      <Text style={styles.rowDetail} numberOfLines={1}>
                        {gone
                          ? lstrings.game_video_gone_suffix
                          : lengthOf(video.durationSec)}
                      </Text>
                    </View>
                  </Pressable>
                  <View style={styles.showCell}>
                    <Switch
                      value={on}
                      disabled={disabled}
                      accessibilityLabel={name}
                      onValueChange={() => {
                        toggle(video.id)
                      }}
                    />
                  </View>
                  <Pressable
                    style={styles.soundCell}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isHeard, disabled: !on }}
                    // react-native-web does not render `aria-checked` from
                    // the state above, and a radio that never says whether it
                    // is chosen is one a screen reader cannot read.
                    aria-checked={isHeard}
                    accessibilityLabel={sprintf(
                      lstrings.angles_sound_from_label,
                      name
                    )}
                    disabled={!on}
                    onPress={() => {
                      setHeard(video.id)
                    }}
                  >
                    <View style={[styles.radio, !on && styles.radioOff]}>
                      {isHeard ? <View style={styles.radioDot} /> : null}
                    </View>
                  </Pressable>
                </View>
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
                onWatch(picked, audio)
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

/** The widths of the Show and Sound columns, heading and rows alike. */
const SHOW_COLUMN_REM = 3.5
const SOUND_COLUMN_REM = 3

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
    maxWidth: theme.rem(30),
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
  // The rows' own gap, padding and column widths, so each heading sits over
  // its column rather than drifting a gap's width to the left of it.
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: theme.rem(theme.spaceSmRem),
    paddingHorizontal: theme.rem(theme.spaceSmRem),
    gap: theme.rem(theme.spaceSmRem)
  },
  headerText: {
    color: theme.secondaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.6875),
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  headerAngle: {
    flex: 1
  },
  headerShow: {
    width: theme.rem(SHOW_COLUMN_REM),
    textAlign: 'center'
  },
  headerSound: {
    width: theme.rem(SOUND_COLUMN_REM),
    textAlign: 'center'
  },
  list: {
    marginTop: theme.rem(theme.spaceXsRem)
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
  rowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem)
  },
  showCell: {
    width: theme.rem(SHOW_COLUMN_REM),
    alignItems: 'center'
  },
  soundCell: {
    width: theme.rem(SOUND_COLUMN_REM),
    minHeight: theme.rem(2.75),
    alignItems: 'center',
    justifyContent: 'center'
  },
  radio: {
    width: theme.rem(1.25),
    height: theme.rem(1.25),
    borderRadius: theme.rem(0.625),
    borderWidth: 2,
    borderColor: theme.activeColor,
    alignItems: 'center',
    justifyContent: 'center'
  },
  radioOff: {
    borderColor: theme.placeholderTextColor
  },
  radioDot: {
    width: theme.rem(0.625),
    height: theme.rem(0.625),
    borderRadius: theme.rem(0.3125),
    backgroundColor: theme.activeColor
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
