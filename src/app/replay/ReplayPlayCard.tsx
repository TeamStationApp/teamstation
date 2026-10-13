import React from 'react'
import { Text, View } from 'react-native'

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
  /** Where the card's bottom edge lands, for what is laid out below it. */
  onBottom?: (bottom: number) => void
}

const CARD_WIDTH = 320
const MARGIN = 12
/** Clears the catcher's nameplate, which hangs just below the figure. */
const BELOW_NAMEPLATE = 24

/**
 * The replay's written play-by-play, in the scoring screen's brown and gold
 * card, just below the catcher.
 */
export function ReplayPlayCard(
  props: ReplayPlayCardProps
): React.ReactElement | null {
  const theme = useTheme()
  const [cardHeight, setCardHeight] = React.useState(0)
  if (props.catcher == null || props.width === 0) return null
  const width = Math.min(CARD_WIDTH, props.width - MARGIN * 2)
  const center = props.catcher.x + props.catcher.width / 2
  const left = Math.max(
    MARGIN,
    Math.min(props.width - MARGIN - width, center - width / 2)
  )
  return (
    <View
      pointerEvents="none"
      testID="replay-play-card"
      accessibilityLiveRegion="polite"
      onLayout={event => {
        const { y, height } = event.nativeEvent.layout
        setCardHeight(height)
        props.onBottom?.(y + height)
      }}
      style={{
        position: 'absolute',
        top: Math.min(
          props.catcher.y + props.catcher.height + BELOW_NAMEPLATE,
          props.height - cardHeight - MARGIN
        ),
        left,
        width,
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
        style={{
          fontFamily: theme.semiBoldTextFont,
          color: theme.scoringInstructionText,
          fontSize: 15
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
