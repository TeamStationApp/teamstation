import React from 'react'
import { Text, View } from 'react-native'

import { type PlanPositionError, positionList } from '../../../common/gamePlan'
import { lstrings, sprintf } from '../../locales/strings'
import { useScoringSheetTheme } from '../scoringSheetTheme'

/**
 * Each inning that is not a complete, unique field, in red: the required
 * positions nobody holds, then the positions two or more players hold. An
 * inning with nothing assigned, and a plan with no errors, show nothing.
 */
export function PlanPositionErrors({
  errors
}: {
  errors: readonly PlanPositionError[]
}): React.ReactElement | null {
  const theme = useScoringSheetTheme()
  if (errors.length === 0) return null
  const style = {
    color: theme.scoringSurface.danger,
    fontFamily: theme.regularTextFont,
    fontSize: 14,
    lineHeight: 20
  }
  return (
    <View testID="Plan position errors" style={{ gap: 6 }}>
      {errors.flatMap(({ inning, missing, duplicated }) => [
        ...(missing.length === 0
          ? []
          : [
              <Text
                key={`missing ${inning}`}
                testID={`Plan position missing ${inning}`}
                accessibilityRole="text"
                style={style}
              >
                {sprintf(
                  lstrings.plan_position_missing,
                  inning,
                  positionList(missing)
                )}
              </Text>
            ]),
        ...(duplicated.length === 0
          ? []
          : [
              <Text
                key={`duplicate ${inning}`}
                testID={`Plan position duplicate ${inning}`}
                accessibilityRole="text"
                style={style}
              >
                {sprintf(
                  lstrings.plan_position_duplicate,
                  inning,
                  positionList(duplicated)
                )}
              </Text>
            ])
      ])}
    </View>
  )
}
