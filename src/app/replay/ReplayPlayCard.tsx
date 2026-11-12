import React from 'react'
import { Text, View, type ViewStyle } from 'react-native'

import type { ScreenRect } from '../field/catcherBounds'
import { useTheme } from '../theme/ThemeContext'

export interface ReplayPlayCardProps {
  /** The step's sentence: what the announcer says. */
  line: string
  /** Where the game stands, or "Paused". */
  detail: string
  /** The catcher on screen; the card hangs below. Hidden until known. */
  catcher: ScreenRect | null
  /** The screen's width and height, to keep the card on it. */
  width: number
  height: number
  /** The card's measured height, for what is laid out around it. */
  onHeight?: (height: number) => void
  /** How much of the line shows: a rewind's words fade out before they go. */
  lineOpacity?: number
  /**
   * `catcher`, the default: hung below the catcher's nameplate. `column`:
   * laid out in the flow of the side column that holds it, full width less
   * its margins, with no catcher.
   */
  placement?: 'catcher' | 'column'
}

const CARD_WIDTH = 320
const MARGIN = 12
/** Clears the catcher's nameplate, which hangs just below the figure. */
export const BELOW_NAMEPLATE = 24

/**
 * The replay's written play-by-play, in the scoring screen's brown and gold
 * card, just below the catcher, or at the top of the box score's column.
 */
export function ReplayPlayCard(
  props: ReplayPlayCardProps
): React.ReactElement | null {
  const theme = useTheme()
  const [cardHeight, setCardHeight] = React.useState(0)
  const column = props.placement === 'column'
  const { catcher } = props
  const shown = column || (catcher != null && props.width > 0)
  const width = Math.min(CARD_WIDTH, props.width - MARGIN * 2)
  // Below the catcher, kept 12 above the screen's bottom.
  const top =
    column || catcher == null
      ? null
      : Math.min(
          catcher.y + catcher.height + BELOW_NAMEPLATE,
          props.height - MARGIN - cardHeight
        )
  const { onHeight } = props
  React.useEffect(() => {
    if (cardHeight > 0) onHeight?.(cardHeight)
  }, [cardHeight, onHeight])
  if (!shown) return null
  // In the column's flow, or hung below the catcher.
  const place: ViewStyle =
    top == null || catcher == null
      ? { marginHorizontal: MARGIN }
      : {
          position: 'absolute',
          top,
          left: Math.max(
            MARGIN,
            Math.min(
              props.width - MARGIN - width,
              catcher.x + catcher.width / 2 - width / 2
            )
          ),
          width
        }
  return (
    <View
      pointerEvents="none"
      testID="replay-play-card"
      accessibilityLiveRegion="polite"
      onLayout={event => {
        setCardHeight(event.nativeEvent.layout.height)
      }}
      style={{
        ...place,
        borderRadius: theme.rem(theme.radiusRem),
        borderWidth: 2,
        borderColor: theme.scoringInstructionBorder,
        backgroundColor: theme.scoringInstructionBackground,
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 2
      }}
    >
      <Text
        testID="replay-play-card-line"
        style={{
          fontFamily: theme.semiBoldTextFont,
          color: theme.scoringInstructionText,
          fontSize: 15,
          opacity: props.lineOpacity ?? 1
        }}
      >
        {props.line}
      </Text>
      {props.detail !== '' && (
        <Text
          style={{
            fontFamily: theme.regularTextFont,
            color: theme.scoringCountdownColor,
            fontSize: 12
          }}
        >
          {props.detail}
        </Text>
      )}
    </View>
  )
}
