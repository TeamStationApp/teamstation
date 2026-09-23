import React from 'react'
import { Pressable, Text, View } from 'react-native'

import type { DjBatter } from '../../common/api'
import { Icon } from '../components'
import { lstrings, sprintf } from '../locales/strings'
import { elevationFor } from '../theme/elevation'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

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
  /** The play button: plays, or stops when this row is the one playing. */
  onPlay: () => void
  /** A tap on a song that is not on this phone, so the screen can say so. */
  onMissing: () => void
}

/**
 * One batter in DJ Game: an off-white box lifted by the card shadow, with a
 * music note, the batter's name and his song — title and artist on one
 * small, muted line — and on the right a play button that becomes stop.
 *
 * The shadow is on an outer wrapper, because Android clips an elevation
 * shadow on the view that rounds its own corners. The play button is hidden
 * when there is no song, and dimmed when the song is not on this phone,
 * where a tap explains why rather than doing nothing.
 */
export function DjLineupRow(props: DjLineupRowProps): React.ReactElement {
  const { batter, onEdit, song, playing, onPlay, onMissing } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const tune = batter.walkUpSong
  const missing = tune != null && song === 'missing'
  const ready = tune != null && typeof song === 'object'

  const details = (
    <>
      <Icon name="music_note" size={1.5} color={theme.secondaryTextColor} />
      <View style={styles.text}>
        <Text style={styles.name} numberOfLines={1}>
          {batter.name}
        </Text>
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
            <Icon
              name={playing ? 'stop' : 'play_arrow'}
              size={1.75}
              color={theme.primaryTextColor}
            />
          </Pressable>
        )}
      </View>
    </View>
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
  name: {
    fontFamily: theme.semiBoldTextFont,
    fontWeight: '600',
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
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
