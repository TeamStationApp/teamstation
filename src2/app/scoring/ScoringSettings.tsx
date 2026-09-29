import React, { useEffect, useState } from 'react'
import { Switch, Text, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import { scoringPreferences } from './scoringPreferences'
import type { ScoringPreferences } from './scoringPreferenceStore'
import { ScoringButton } from './ScoringSheet'

export function ScoringSettings({
  userId,
  onSoundChange,
  onAnimationsChange
}: {
  userId: string
  onSoundChange?: (enabled: boolean) => void
  onAnimationsChange?: (enabled: boolean) => void
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
  const rowText = {
    flex: 1,
    color: theme.primaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: 16
  }
  const row = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 12,
    minHeight: 48
  }
  const toggle = (
    label: string,
    text: string,
    on: boolean,
    change: (on: boolean) => void
  ): React.ReactElement => (
    <View style={row}>
      <Text style={rowText}>{text}</Text>
      <Switch
        accessibilityLabel={label}
        value={on}
        disabled={value == null}
        onValueChange={change}
      />
    </View>
  )
  return (
    <View style={{ gap: 8 }}>
      {toggle(
        'Toggle scoring sound',
        'Scoring sound',
        value?.sound !== false,
        on => {
          if (value == null) return
          update({ ...value, sound: on })
          onSoundChange?.(on)
        }
      )}
      {toggle(
        'Toggle play animations',
        'Animate plays',
        value?.animations !== false,
        on => {
          if (value == null) return
          update({ ...value, animations: on })
          onAnimationsChange?.(on)
        }
      )}
      {toggle(
        'Toggle switch-hitter help',
        'Switch-hitter help',
        value?.help !== false,
        on => {
          if (value != null) update({ ...value, help: on })
        }
      )}
      <View style={row}>
        <Text style={rowText}>
          Switch-hitter help shown {value?.shown ?? 0} of 3 times
        </Text>
        <ScoringButton
          label="Reset shown count"
          text="Reset"
          disabled={value == null}
          onPress={() => {
            if (value != null) update({ ...value, shown: 0 })
          }}
        />
      </View>
    </View>
  )
}
