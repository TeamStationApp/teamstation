import React from 'react'
import { Text, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import type { RunnerDragView } from './runnerDrag'
export function RunnerDragTargets({
  view
}: {
  view: RunnerDragView | null
}): React.ReactElement | null {
  const theme = useTheme()
  if (view == null) return null
  return (
    <View pointerEvents="none" style={{ position: 'absolute', inset: 0 }}>
      {(['safe', 'out'] as const).map(key => (
        <View
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
                ? view.hovered === key
                  ? theme.scoringSafeColor
                  : theme.scoringSafeIdleColor
                : view.hovered === key
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
        </View>
      ))}
    </View>
  )
}
