import React, { useEffect, useState } from 'react'
import { Platform, Pressable, Switch, Text, View } from 'react-native'

import {
  DICTATION_MODEL_NAMES,
  DICTATION_MODELS,
  type DictationModel,
  dictationModelOf,
  type Health
} from '../../common/api'
import { RadioMark } from '../components/RadioMark'
import { useTheme } from '../theme/ThemeContext'
import { scoringPreferences } from './scoringPreferences'
import type { ScoringPreferences } from './scoringPreferenceStore'
import { ScoringButton } from './ScoringSheet'

export function ScoringSettings({
  userId,
  health,
  onSoundChange,
  onAnimationsChange,
  onDictationModelChange
}: {
  userId: string
  /** Where the dictation models this server offers are read from. */
  health?: () => Promise<Health>
  onSoundChange?: (enabled: boolean) => void
  onAnimationsChange?: (enabled: boolean) => void
  onDictationModelChange?: (model: DictationModel) => void
}): React.ReactElement {
  const theme = useTheme()
  const [value, setValue] = useState<ScoringPreferences>()
  const [offered, setOffered] = useState<readonly string[]>()
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
  useEffect(() => {
    let live = true
    health?.().then(
      reply => {
        if (live) setOffered(reply.dictation ? reply.dictationModels : [])
      },
      () => undefined
    )
    return () => {
      live = false
    }
  }, [health])
  const update = (next: ScoringPreferences): void => {
    setValue(next)
    scoringPreferences.write(userId, next).catch(() => undefined)
  }
  const chosen =
    offered == null
      ? undefined
      : dictationModelOf(value?.dictationModel, offered)
  const heading = {
    color: theme.primaryTextColor,
    fontFamily: theme.boldTextFont,
    fontSize: 17
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
      {offered != null && offered.length > 0 && (
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel="Dictation Model"
          style={{ gap: 2, marginBottom: 12 }}
        >
          <Text accessibilityRole="header" style={heading}>
            Dictation Model
          </Text>
          {DICTATION_MODELS.map(model => {
            const available = offered.includes(model)
            const on = model === chosen
            return (
              <Pressable
                key={model}
                accessibilityRole="radio"
                accessibilityLabel={DICTATION_MODEL_NAMES[model]}
                accessibilityState={{ checked: on, disabled: !available }}
                aria-checked={on}
                disabled={!available || value == null}
                onPress={() => {
                  if (value == null) return
                  update({ ...value, dictationModel: model })
                  onDictationModelChange?.(model)
                }}
                style={{ ...row, opacity: available ? 1 : 0.45 }}
              >
                <Text style={rowText}>
                  {DICTATION_MODEL_NAMES[model]}
                  {available ? '' : ' — not set up on this server'}
                </Text>
                <RadioMark on={on} />
              </Pressable>
            )
          })}
        </View>
      )}
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
