import React, { useEffect } from 'react'
import { Pressable, Text, View } from 'react-native'
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming
} from 'react-native-reanimated'

import type { DjBatter } from '../../common/api'
import { Icon } from '../components'
import { lstrings, sprintf } from '../locales/strings'
import { elevationFor } from '../theme/elevation'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { AT_BAT_BLUE, AT_BAT_FADE_MS } from './atBatColors'
import { AtBatSweep } from './AtBatSweep'

/**
 * Where a row's song is on this phone: still being looked for, found (the
 * handle `music` plays it with), or not here.
 */
export type RowSong = 'resolving' | 'missing' | { handle: string }

export interface DjLineupRowProps {
  batter: DjBatter
  /**
   * Opens the song picker for this batter. Absent for a batter nobody here
   * may edit — another team's, or a placeholder named at the field — and
   * then the left part of the row does nothing.
   */
  onEdit?: () => void
  /** Where the song is on this phone; ignored without a song. */
  song: RowSong
  playing: boolean
  /**
   * This batter is at the plate. `in` and `out` fade the ring; `steady` holds
   * it. Absent for every other row.
   */
  outline?: 'steady' | 'in' | 'out' | null
  /** The play button: plays, or stops when this row is the one playing. */
  onPlay: () => void
  /** A tap on a song that is not on this phone, so the screen can say so. */
  onMissing: () => void
}

/**
 * One batter in DJ Game: an off-white box lifted by the card shadow, with a
 * music note, the batter's name and his song — title and artist on one
 * small, muted line — and on the right a solid play triangle that becomes a
 * solid stop square. The batter at the plate has a blue line around the
 * card, and the words "at bat" beside the name. While that batter's song
 * plays, the line is a glowing string of blue, purple and green, pulled
 * clockwise around the whole edge.
 *
 * The shadow is on an outer wrapper, because Android clips an elevation
 * shadow on the view that rounds its own corners. The play button is hidden
 * when there is no song, and dimmed when the song is not on this phone,
 * where a tap explains why rather than doing nothing.
 */
export function DjLineupRow(props: DjLineupRowProps): React.ReactElement {
  const {
    batter,
    onEdit,
    song,
    playing,
    outline = null,
    onPlay,
    onMissing
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const tune = batter.walkUpSong
  const missing = tune != null && song === 'missing'
  const ready = tune != null && typeof song === 'object'
  const atBat = outline != null

  const details = (
    <>
      <Icon name="music_note" size={1.5} color={theme.secondaryTextColor} />
      <View style={styles.text}>
        <View style={styles.nameRow}>
          <Text style={styles.name} numberOfLines={1}>
            {batter.name}
          </Text>
          {atBat && (
            <Text style={styles.atBat} testID="DJ at bat">
              {lstrings.dj_at_bat}
            </Text>
          )}
        </View>
        <Text style={styles.song} numberOfLines={1} testID="DJ song line">
          {tune == null
            ? lstrings.dj_no_song
            : sprintf(lstrings.dj_song, tune.title, tune.artist)}
        </Text>
      </View>
    </>
  )

  return (
    <View style={styles.shadow} testID="DJ row">
      <View style={styles.frame}>
        <View style={styles.box}>
          {onEdit == null ? (
            <View style={styles.left}>{details}</View>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={sprintf(lstrings.dj_edit, batter.name)}
              onPress={onEdit}
              style={styles.left}
            >
              {details}
            </Pressable>
          )}
          {tune != null && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={sprintf(
                playing ? lstrings.dj_stop : lstrings.dj_play,
                batter.name
              )}
              accessibilityState={{ disabled: !ready }}
              onPress={() => {
                if (ready) onPlay()
                else if (missing) onMissing()
              }}
              style={[styles.play, !ready && styles.dimmed]}
            >
              <TransportMark playing={playing} color={theme.primaryTextColor} />
            </Pressable>
          )}
        </View>
      </View>
      {outline != null && <AtBatRing phase={outline} playing={playing} />}
    </View>
  )
}

/** The blue line, fading, or the glowing string while this song plays. */
function AtBatRing(props: {
  phase: 'steady' | 'in' | 'out'
  playing: boolean
}): React.ReactElement {
  const opacity = useSharedValue(props.phase === 'in' ? 0 : 1)
  useEffect(() => {
    opacity.value = withTiming(props.phase === 'out' ? 0 : 1, {
      duration: AT_BAT_FADE_MS
    })
  }, [opacity, props.phase])
  const fade = useAnimatedStyle(() => ({ opacity: opacity.value }))
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          bottom: 0,
          overflow: 'visible'
        },
        fade
      ]}
    >
      {props.playing ? (
        <AtBatSweep />
      ) : (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            bottom: 0,
            borderRadius: 12,
            borderWidth: 3,
            borderColor: AT_BAT_BLUE
          }}
        />
      )}
    </Animated.View>
  )
}

/** A solid play triangle, or a solid stop square. No button chrome. */
function TransportMark(props: {
  playing: boolean
  color: string
}): React.ReactElement {
  if (props.playing) {
    return (
      <View
        testID="DJ stop glyph"
        style={{ width: 14, height: 14, backgroundColor: props.color }}
      />
    )
  }
  return (
    <View
      testID="DJ play glyph"
      style={{
        width: 0,
        height: 0,
        borderStyle: 'solid',
        borderTopWidth: 9,
        borderBottomWidth: 9,
        borderLeftWidth: 16,
        borderTopColor: 'transparent',
        borderBottomColor: 'transparent',
        borderLeftColor: props.color
      }}
    />
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  shadow: {
    borderRadius: 12,
    backgroundColor: theme.backgroundColor,
    shadowColor: theme.shadowColor,
    shadowOpacity: 1,
    shadowRadius: theme.rem(0.375),
    shadowOffset: { width: 0, height: theme.rem(0.125) },
    elevation: elevationFor(theme.rem(0.375))
  },
  frame: {
    borderRadius: 12,
    overflow: 'hidden'
  },
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 64,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: theme.backgroundColor
  },
  left: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
    paddingLeft: 16,
    paddingRight: 8,
    minHeight: 64
  },
  text: {
    flex: 1,
    gap: 2
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6
  },
  name: {
    flexShrink: 1,
    fontFamily: theme.semiBoldTextFont,
    fontWeight: '600',
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  },
  atBat: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.75),
    color: theme.secondaryTextColor
  },
  song: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  play: {
    width: 48,
    height: 48,
    marginRight: 8,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 24
  },
  dimmed: {
    opacity: 0.35
  }
}))
