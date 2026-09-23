import React, { useEffect, useState } from 'react'
import { Text, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import { scoringPreferences } from './scoringPreferences'
import type { ScoringPreferences } from './scoringPreferenceStore'
import { ScoringButton } from './ScoringSheet'
export function ScoringSettings({
  userId
}: {
  userId: string
}): React.ReactElement {
  const theme = useTheme()
  const [value, setValue] = useState<ScoringPreferences>()
  useEffect(() => {
    let live = true
    scoringPreferences
      .read(userId)
      .then(settings => {
        if (live) setValue(settings)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [userId])
  const update = (next: ScoringPreferences): void => {
    setValue(next)
    scoringPreferences.write(userId, next).catch(() => undefined)
  }
  return (
    <View style={{ gap: 12 }}>
      <Text
        style={{
          color: theme.primaryTextColor,
          fontFamily: theme.regularTextFont
        }}
      >
        Switch-hitter help: {value?.help === false ? 'Off' : 'On'}
      </Text>
      <ScoringButton
        label="Toggle switch-hitter help"
        disabled={value == null}
        onPress={() => {
          if (value != null) update({ ...value, help: !value.help })
        }}
      />
      <ScoringButton
        label="Reset shown count"
        disabled={value == null}
        onPress={() => {
          if (value != null) update({ ...value, shown: 0 })
        }}
      />
      <Text
        style={{
          color: theme.primaryTextColor,
          fontFamily: theme.regularTextFont
        }}
      >
        Shown {value?.shown ?? 0} of 3 times
      </Text>
    </View>
  )
}
