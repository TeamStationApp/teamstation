import React from 'react'
import { Text } from 'react-native'

import { Screen } from '../components'
import { useTheme } from '../theme/ThemeContext'

/** What a phone shows at a sponsor screen's address: it is the web's. */
function WebOnly(): React.ReactElement {
  const theme = useTheme()
  return (
    <Screen>
      <Text
        style={{
          paddingVertical: theme.rem(1),
          color: theme.primaryTextColor,
          fontFamily: theme.regularTextFont,
          fontSize: theme.rem(1)
        }}
      >
        Sponsor features are set up on the web.
      </Text>
    </Screen>
  )
}

/** The same names as SponsorScreens.tsx, each the web-only notice. */
export function SponsorLogosScreen(_props: {
  client: unknown
  league: string
}): React.ReactElement {
  return <WebOnly />
}
