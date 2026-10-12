import React, { useState } from 'react'
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native'

import { Icon } from '../../components/Icon'
import { lstrings } from '../../locales/strings'
import {
  type PhoneStream,
  PhoneStreamError,
  type RadarDevice,
  type RadarState
} from '../phoneStreamClient'
import { SettingsCard } from './SettingsCard'
import { SETTINGS, SETTINGS_MONOSPACE } from './settingsTheme'

/** One speed as the row shows it: whole miles an hour, or a dash when there is none. */
const mph = (value: number | null): string =>
  value == null ? '–' : String(Math.round(value))

/**
 * The words after a paired radar's serial, each with its leading " · ":
 * "Connected" while it is, its battery, and its last pitch and exit speeds.
 */
export function radarRowParts(
  device: RadarDevice
): Array<{ text: string; connected?: boolean }> {
  const parts: Array<{ text: string; connected?: boolean }> = []
  if (device.connection === 'connected')
    parts.push({
      text: ` · ${lstrings.stream_settings_connected}`,
      connected: true
    })
  if (device.batteryPercent != null)
    parts.push({ text: ` · ⚡${Math.round(device.batteryPercent)}%` })
  parts.push({
    text: ` · ${mph(device.pitchMph)} / ${mph(device.exitMph)} ${lstrings.stream_settings_mph}`
  })
  return parts
}

export interface RadarCardProps {
  phone: PhoneStream
  radar: RadarState | null
  /** Pair Device: the sheet opens the device picker. */
  onPair: () => void
}

/**
 * The Radar card: what it is for, an On switch, a row for each paired radar
 * with its link, battery and speeds and an Unpair, and Pair Device last.
 *
 * Turning it on asks Android for Bluetooth first (`radarSetEnabled`). Pair
 * Device turns it on too when it is off, since the fleet looks for nothing
 * while it is off.
 */
export function RadarCard(props: RadarCardProps): React.ReactElement {
  const { phone, radar, onPair } = props
  /** What the switch was just set to, until the engine reports it. */
  const [asked, setAsked] = useState<boolean | undefined>(undefined)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  const enabled = radar?.enabled ?? false
  const shown = asked ?? enabled

  const setEnabled = async (next: boolean): Promise<boolean> => {
    setAsked(next)
    setProblem(undefined)
    try {
      await phone.radarSetEnabled(next)
      return true
    } catch (error) {
      setProblem(
        error instanceof PhoneStreamError && error.code === 'permission'
          ? lstrings.stream_settings_permission
          : error instanceof Error
            ? error.message
            : String(error)
      )
      return false
    } finally {
      setAsked(undefined)
    }
  }

  const unpair = (serial: string): void => {
    setProblem(undefined)
    phone.radarUnpair(serial).catch((error: unknown) => {
      setProblem(error instanceof Error ? error.message : String(error))
    })
  }

  const pair = (): void => {
    if (enabled) {
      onPair()
      return
    }
    setEnabled(true).then(
      on => {
        if (on) onPair()
      },
      () => {}
    )
  }

  return (
    <SettingsCard
      title={lstrings.stream_settings_radar}
      testID="settings-radar"
    >
      <Text style={[styles.row, styles.intro]}>
        {lstrings.stream_settings_radar_intro}
      </Text>
      <View style={styles.separator} />
      <View style={[styles.row, styles.switchRow]}>
        <Text style={styles.label}>{lstrings.stream_settings_radar_on}</Text>
        <Switch
          testID="settings-radar-enabled"
          accessibilityLabel={lstrings.stream_settings_radar}
          value={shown}
          onValueChange={next => {
            setEnabled(next).catch(() => {})
          }}
        />
      </View>
      {radar?.bluetooth === 'off' && shown ? (
        <Text style={[styles.row, styles.problem]}>
          {lstrings.stream_settings_bluetooth_off}
        </Text>
      ) : null}
      {problem != null ? (
        <Text
          testID="settings-radar-problem"
          style={[styles.row, styles.problem]}
        >
          {problem}
        </Text>
      ) : null}
      {shown
        ? (radar?.devices ?? []).map(device => (
            <View key={device.serial}>
              <View style={styles.separator} />
              <View
                testID={`settings-radar-device-${device.serial}`}
                style={[styles.row, styles.deviceRow]}
              >
                <Text style={styles.device} numberOfLines={1}>
                  <Text style={styles.serial}>{device.serial}</Text>
                  {radarRowParts(device).map(part => (
                    <Text
                      key={part.text}
                      style={part.connected === true ? styles.connected : null}
                    >
                      {part.text}
                    </Text>
                  ))}
                </Text>
                <Pressable
                  testID={`settings-radar-unpair-${device.serial}`}
                  accessibilityRole="button"
                  accessibilityLabel={`${lstrings.stream_settings_unpair} ${device.serial}`}
                  hitSlop={8}
                  onPress={() => {
                    unpair(device.serial)
                  }}
                >
                  <Text style={styles.unpair}>
                    {lstrings.stream_settings_unpair}
                  </Text>
                </Pressable>
              </View>
            </View>
          ))
        : null}
      <View style={styles.separator} />
      <Pressable
        testID="settings-radar-pair"
        accessibilityRole="button"
        style={[styles.row, styles.pairRow]}
        onPress={pair}
      >
        <Text style={styles.pair}>{lstrings.stream_settings_pair_device}</Text>
        <Icon name="chevron_right" size={1.1} color={SETTINGS.blue} />
      </Pressable>
    </SettingsCard>
  )
}

const styles = StyleSheet.create({
  row: {
    paddingHorizontal: SETTINGS.rowInset,
    paddingVertical: SETTINGS.rowVertical
  },
  intro: {
    color: SETTINGS.secondaryText,
    fontSize: SETTINGS.footnote
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: SETTINGS.rowInset,
    backgroundColor: SETTINGS.separator
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  label: {
    color: SETTINGS.text,
    fontSize: SETTINGS.body
  },
  problem: {
    color: SETTINGS.red,
    fontSize: SETTINGS.footnote
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12
  },
  device: {
    flex: 1,
    color: SETTINGS.text,
    fontSize: SETTINGS.body - 2,
    fontVariant: ['tabular-nums']
  },
  serial: {
    fontFamily: SETTINGS_MONOSPACE
  },
  connected: {
    color: SETTINGS.connected
  },
  unpair: {
    color: SETTINGS.red,
    fontSize: SETTINGS.body
  },
  pairRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  pair: {
    color: SETTINGS.blue,
    fontSize: SETTINGS.body
  }
})
