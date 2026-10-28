import React from 'react'
import { View } from 'react-native'

import { Icon, type IconName } from '../components/Icon'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import type { GridZone, PlacedIcon } from './pressGrid'

/**
 * The controls group's icons, where `placeIcons` puts them: the sound in the
 * top-left corner, ten seconds back down the left, play or pause in the
 * middle, ten seconds on down the right, and the corner's own icon in the
 * top-right corner where it is given one. The two corner icons sit over the
 * board, and the rest clear of it and its box score. The full-screen
 * player's corner is its ✕, which it draws itself.
 *
 * Icons only: they take no touch. A press on one while they show runs it,
 * and a press anywhere else is its square's (`zoneAt`), in the press layer
 * under them.
 */
export function ZoneIcons(props: {
  icons: PlacedIcon[]
  visible: boolean
  playing: boolean
  soundOff: boolean
  /** The icon of the top-right square: the card's way into full screen. */
  corner?: IconName
}): React.ReactElement {
  const { icons, visible, playing, soundOff, corner } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const name = (zone: GridZone): IconName | null =>
    zone === 'audio'
      ? soundOff
        ? 'volume_off'
        : 'volume_up'
      : zone === 'seekBack'
        ? 'replay_10'
        : zone === 'toggle'
          ? playing
            ? 'pause'
            : 'play_arrow'
          : zone === 'seekForward'
            ? 'forward_10'
            : zone === 'corner'
              ? (corner ?? null)
              : null
  return (
    <View
      pointerEvents="none"
      style={[styles.layer, { opacity: visible ? 1 : 0 }]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {icons.map(icon => {
        const shown = name(icon.zone)
        if (shown == null) return null
        return (
          <View
            key={icon.zone}
            testID={`zoneIcon-${shown}`}
            style={[
              styles.circle,
              // The corners' sit over the board: solid enough to read on it.
              icon.zone === 'audio' || icon.zone === 'corner'
                ? styles.overBoard
                : null,
              {
                left: icon.x - icon.r,
                top: icon.y - icon.r,
                width: icon.r * 2,
                height: icon.r * 2,
                borderRadius: icon.r
              }
            ]}
          >
            <Icon
              name={shown}
              size={(icon.r * 2 * 7) / 12 / theme.rem(1)}
              color="rgba(255, 255, 255, 0.9)"
            />
          </View>
        )
      })}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  layer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    // Over the pictures and the press layer, under the ✕ and the bar.
    zIndex: 5
  },
  circle: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.45)'
  },
  overBoard: {
    backgroundColor: 'rgba(0, 0, 0, 0.8)'
  }
}))
