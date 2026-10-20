import React from 'react'
import { Pressable, StyleSheet, View } from 'react-native'

import { lstrings } from '../locales/strings'
import { elevationFor } from '../theme/elevation'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import {
  PictureScoreboard,
  type PictureScoreboardProps
} from './scoreboardOverlay/ScoreboardOverlay'
import type { VideoHandle } from './videoHandle'

export interface PlayerSurfaceProps {
  videoRef: React.RefObject<VideoHandle | null>
  width: number
  height: number
  /**
   * False while the full-screen player has the screen. It is a state of the
   * game screen, not a route, so this picture is still mounted behind it, and
   * its board would go on asking for steps nobody can see.
   */
  active?: boolean
  /**
   * The game's board over the picture, at the wall time of the frame on
   * screen: the game and the video it is of, whether it is live, and where
   * the picture is in this view. Absent, no board.
   */
  scoreboard?: Omit<PictureScoreboardProps, 'videoRef'>
  /** A press anywhere on the picture: opens the full-screen player. */
  onOpen?: () => void
  children: React.ReactNode
}

/**
 * The videos page's picture: the video, its board, and one press that opens
 * the full-screen player.
 *
 * It has no controls, taps, holds or keys of its own. Watching is done in the
 * full-screen player, one angle or several, which has all of them; a picture
 * that half-played inline beside it was two players to learn. The board
 * stays, at the node's `single` placement, so the page shows the score at
 * the frame on screen.
 */
export function PlayerSurface(props: PlayerSurfaceProps): React.ReactElement {
  const {
    videoRef,
    width,
    height,
    active = true,
    scoreboard,
    onOpen,
    children
  } = props
  const styles = getStyles(useTheme())

  return (
    <View style={[styles.surface, { width, height }]}>
      {children}
      {scoreboard != null && active ? (
        <PictureScoreboard {...scoreboard} videoRef={videoRef} />
      ) : null}
      {onOpen != null ? (
        <Pressable
          testID="gameVideoOpen"
          accessibilityRole="button"
          accessibilityLabel={lstrings.game_video_open}
          onPress={onOpen}
          style={StyleSheet.absoluteFill}
        />
      ) : null}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  surface: {
    position: 'relative',
    backgroundColor: '#000000',
    overflow: 'hidden',
    borderRadius: theme.rem(theme.radiusRem),
    // The highlights run under the picture while it is pegged, so it needs to
    // read as being above them rather than as a hole they vanish into.
    shadowColor: theme.shadowColor,
    shadowOpacity: 1,
    shadowRadius: theme.rem(0.75),
    shadowOffset: { width: 0, height: theme.rem(0.25) },
    elevation: elevationFor(theme.rem(0.75))
  }
}))
