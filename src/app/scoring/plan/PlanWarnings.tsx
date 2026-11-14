import React from 'react'
import { Text, View } from 'react-native'

import type { PlanWarning } from '../../../common/planWarnings'
import { lstrings, sprintf } from '../../locales/strings'
import { useScoringSheetTheme } from '../scoringSheetTheme'

/**
 * The plan's playing-time warnings, reds first: a red or yellow dot and the
 * warning. A team with rules and nothing to warn about is told so; one with
 * no rules, which only a duplicate position can warn, sees nothing.
 */
export function PlanWarnings({
  warnings,
  rules
}: {
  warnings: readonly PlanWarning[]
  rules: boolean
}): React.ReactElement | null {
  const theme = useScoringSheetTheme()
  const surface = theme.scoringSurface
  const text = {
    flex: 1,
    fontFamily: theme.regularTextFont,
    fontSize: 14,
    lineHeight: 20
  }
  if (warnings.length === 0)
    return rules ? (
      <Text
        testID="Plan warnings"
        style={{ ...text, color: surface.mutedText }}
      >
        {lstrings.plan_no_warnings}
      </Text>
    ) : null
  return (
    <View testID="Plan warnings" style={{ gap: 6 }}>
      {warnings.map(warning => {
        const red = warning.level === 'red'
        return (
          <View
            key={`${warning.rule}|${warning.level}|${warning.message}`}
            testID={`Plan warning ${warning.level} ${warning.rule}`}
            accessible
            accessibilityRole="text"
            accessibilityLabel={sprintf(
              red ? lstrings.plan_warning_red : lstrings.plan_warning_yellow,
              warning.message
            )}
            style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}
          >
            <View
              style={{
                width: 8,
                height: 8,
                marginTop: 6,
                borderRadius: 4,
                backgroundColor: red
                  ? surface.danger
                  : surface.badges.amber.text
              }}
            />
            <Text
              style={{
                ...text,
                color: red ? surface.danger : surface.badges.amber.text
              }}
            >
              {warning.message}
            </Text>
          </View>
        )
      })}
    </View>
  )
}
