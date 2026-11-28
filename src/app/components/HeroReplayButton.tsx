import React from 'react'
import Animated from 'react-native-reanimated'

import { useLivePulse } from './LivePill'
import { PillButton } from './PillTabs'

export interface HeroReplayButtonProps {
  kind: 'live' | 'replay'
  label: string
  onPress: () => void
  /** The session is still being restored: drawn at half opacity, not pressable. */
  disabled?: boolean
  /** Hold the Live pulse still (a browser with the game's video on the page). */
  still?: boolean
}

/**
 * A game hero's Live / Replay: a compact pill, so it is the size of the
 * section pills under the card, in red while the game is scored (breathing as
 * the live pill does) and in green once it is over.
 */
export function HeroReplayButton(
  props: HeroReplayButtonProps
): React.ReactElement {
  const { kind, label, onPress, disabled = false, still = false } = props
  const pulse = useLivePulse(kind === 'live' && !still)
  return (
    <Animated.View style={pulse}>
      <PillButton
        label={label}
        accessibilityLabel={label}
        size="compact"
        tone={kind}
        role="button"
        testID="game-hero-replay"
        disabled={disabled}
        onPress={onPress}
      />
    </Animated.View>
  )
}
