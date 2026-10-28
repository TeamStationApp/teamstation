import React, { useEffect, useState } from 'react'
import { Platform, Switch, Text, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import { scoringPreferences } from './scoringPreferences'
import type { ScoringPreferences } from './scoringPreferenceStore'
import { ScoringButton } from './ScoringSheet'

/**
 * The scoring screen's settings: sound, play animations and switch-hitter
 * help. Dictation keeps whatever model is stored for this scorer, or the
 * default, and offers no choice here.
 */
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
  /** Changes these fields, here and in the stored preferences, alone. */
  const update = (patch: Partial<ScoringPreferences>): void => {
    setValue(shown => (shown == null ? shown : { ...shown, ...patch }))
    scoringPreferences
      .update(userId, stored => ({ ...stored, ...patch }))
      .catch(() => undefined)
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
        trackColor={{
          false: theme.scoringSurface.inputBorder,
          true: theme.scoringSurface.active
        }}
        thumbColor={theme.scoringSurface.switchThumb}
        {...(Platform.OS === 'web'
          ? { activeThumbColor: theme.scoringSurface.switchThumb }
          : {})}
        ios_backgroundColor={theme.scoringSurface.idle}
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
          update({ sound: on })
          onSoundChange?.(on)
        }
      )}
      {toggle(
        'Toggle play animations',
        'Animate plays',
        value?.animations !== false,
        on => {
          if (value == null) return
          update({ animations: on })
          onAnimationsChange?.(on)
        }
      )}
      {toggle(
        'Toggle switch-hitter help',
        'Switch-hitter help',
        value?.help !== false,
        on => {
          if (value != null) update({ help: on })
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
            if (value != null) update({ shown: 0 })
          }}
        />
      </View>
    </View>
  )
}
