import React, { useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import type { RunnerDragView } from './runnerDrag'
import { useMenuEscape } from './useMenuEscape'
export function RunnerDragTargets({
  view,
  onChoose,
  onCancel
}: {
  view: RunnerDragView | null
  onChoose?: (decision: 'safe' | 'out') => void
  onCancel?: () => void
}): React.ReactElement | null {
  const theme = useTheme()
  const [focused, setFocused] = useState<string>()
  useMenuEscape(
    view?.keyboard === true,
    () => {
      onCancel?.()
    },
    ''
  )
  if (view == null) return null
  return (
    <View pointerEvents="none" style={{ position: 'absolute', inset: 0 }}>
      {(['safe', 'out'] as const).map(key => (
        <Pressable
          accessibilityRole="button"
          focusable={view.keyboard === true}
          disabled={key === 'safe' && view.safeDisabled != null}
          onPress={() => {
            if (view.keyboard === true) onChoose?.(key)
          }}
          onFocus={() => {
            setFocused(key)
          }}
          onBlur={() => {
            setFocused(undefined)
          }}
          key={key}
          accessibilityState={{
            disabled: key === 'safe' && view.safeDisabled != null
          }}
          accessibilityHint={key === 'safe' ? view.safeDisabled : undefined}
          accessibilityLabel={`${key === 'safe' ? 'Safe' : 'Out'} drag target`}
          style={{
            position: 'absolute',
            left: view[key].x,
            top: view[key].y,
            width: view[key].width,
            height: view[key].height,
            borderRadius: theme.rem(theme.radiusRem),
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor:
              key === 'safe'
                ? view.hovered === key || focused === key
                  ? theme.scoringSafeColor
                  : theme.scoringSafeIdleColor
                : view.hovered === key || focused === key
                  ? theme.scoringOutColor
                  : theme.scoringOutIdleColor
          }}
        >
          <Text
            selectable={false}
            style={{
              fontFamily: theme.semiBoldTextFont,
              color: theme.scoringDecisionText
            }}
          >
            {key === 'safe' ? 'Safe' : 'Out'}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}
