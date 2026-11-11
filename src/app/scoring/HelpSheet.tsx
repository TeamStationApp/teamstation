import React from 'react'
import { Text } from 'react-native'

import { lstrings } from '../locales/strings'
import { ScoringSheet } from './ScoringSheet'
import { useScoringSheetTheme } from './scoringSheetTheme'

/**
 * A tab's help, in a sheet that slides up from the bottom only as tall as
 * its text. Done, a pull down or a tap on the backdrop closes it.
 */
export function HelpSheet({
  text,
  onClose
}: {
  text: string
  onClose: () => void
}): React.ReactElement {
  const theme = useScoringSheetTheme()
  return (
    <ScoringSheet
      title={lstrings.roster_help}
      scroll={false}
      swipeToDismiss
      done
      onClose={onClose}
    >
      <Text
        testID="Help sheet text"
        style={{
          color: theme.primaryTextColor,
          fontFamily: theme.regularTextFont,
          fontSize: 16,
          lineHeight: 22
        }}
      >
        {text}
      </Text>
    </ScoringSheet>
  )
}
