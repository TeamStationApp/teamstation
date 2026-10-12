import React, { useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native'

import { sprintf } from '../../locales/strings'
import type { PhoneStream, RadarState } from '../phoneStreamClient'
import { settingsStrings as words } from './settingsStrings'
import { SETTINGS, SETTINGS_MONOSPACE } from './settingsTheme'

/** Every orientation: the sheet under it turns with the phone. */
export const ALL_ORIENTATIONS: Array<
  'portrait' | 'portrait-upside-down' | 'landscape-left' | 'landscape-right'
> = ['portrait', 'portrait-upside-down', 'landscape-left', 'landscape-right']

export interface PairDeviceModalProps {
  phone: PhoneStream
  radar: RadarState | null
  onClose: () => void
}

/**
 * The radar picker Pair Device opens. It scans while it is up and lists the
 * radars in range that are not paired yet, or "No radars in range" with a
 * spinner while it keeps looking. Tapping one pairs it and closes the picker;
 * Close stops the scan.
 */
export function PairDeviceModal(
  props: PairDeviceModalProps
): React.ReactElement {
  const { phone, radar, onClose } = props
  const [busy, setBusy] = useState<string | undefined>(undefined)
  const [problem, setProblem] = useState<string | undefined>(undefined)

  // Scans while the picker is up, however it goes away.
  useEffect(() => {
    phone.radarScan().catch((error: unknown) => {
      setProblem(error instanceof Error ? error.message : String(error))
    })
    return () => {
      phone.radarStopScan().catch(() => {})
    }
  }, [phone])

  const pair = (serial: string): void => {
    if (busy != null) return
    setBusy(serial)
    setProblem(undefined)
    phone.radarPair(serial).then(
      paired => {
        setBusy(undefined)
        if (paired) onClose()
        else setProblem(sprintf(words.pairFailed, serial))
      },
      (error: unknown) => {
        setBusy(undefined)
        setProblem(error instanceof Error ? error.message : String(error))
      }
    )
  }

  const nearby = radar?.nearby ?? []
  return (
    <Modal
      visible
      transparent
      animationType="fade"
      supportedOrientations={ALL_ORIENTATIONS}
      onRequestClose={onClose}
    >
      <View style={styles.scrim}>
        <View style={styles.sheet} testID="pair-device-modal">
          <Text style={styles.title}>{words.pairTitle}</Text>
          <ScrollView style={styles.list}>
            {nearby.length === 0 ? (
              <View style={styles.empty} testID="pair-device-empty">
                <ActivityIndicator color={SETTINGS.secondaryText} />
                <Text style={styles.emptyText}>{words.pairNone}</Text>
              </View>
            ) : (
              nearby.map((serial, index) => (
                <View key={serial}>
                  {index > 0 ? <View style={styles.separator} /> : null}
                  <Pressable
                    testID={`pair-device-${serial}`}
                    accessibilityRole="button"
                    style={styles.row}
                    onPress={() => {
                      pair(serial)
                    }}
                  >
                    <Text style={styles.serial}>{serial}</Text>
                    {busy === serial ? (
                      <ActivityIndicator color={SETTINGS.secondaryText} />
                    ) : null}
                  </Pressable>
                </View>
              ))
            )}
          </ScrollView>
          {problem != null ? (
            <Text testID="pair-device-problem" style={styles.problem}>
              {problem}
            </Text>
          ) : null}
          <Pressable
            testID="pair-device-close"
            accessibilityRole="button"
            style={styles.close}
            onPress={onClose}
          >
            <Text style={styles.closeText}>{words.close}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    padding: SETTINGS.gap
  },
  sheet: {
    width: '100%',
    maxWidth: 380,
    maxHeight: '90%',
    borderRadius: SETTINGS.cardRadius,
    backgroundColor: SETTINGS.card,
    paddingTop: SETTINGS.gap,
    overflow: 'hidden'
  },
  title: {
    color: SETTINGS.text,
    fontSize: SETTINGS.body,
    fontWeight: '600',
    textAlign: 'center',
    paddingBottom: SETTINGS.rowVertical
  },
  list: {
    flexGrow: 0
  },
  empty: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    paddingVertical: SETTINGS.gap
  },
  emptyText: {
    color: SETTINGS.secondaryText,
    fontSize: SETTINGS.body
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: SETTINGS.rowInset,
    backgroundColor: SETTINGS.separator
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SETTINGS.rowInset,
    paddingVertical: SETTINGS.rowVertical + 2
  },
  serial: {
    color: SETTINGS.blue,
    fontSize: SETTINGS.body,
    fontFamily: SETTINGS_MONOSPACE
  },
  problem: {
    color: SETTINGS.red,
    fontSize: SETTINGS.footnote,
    paddingHorizontal: SETTINGS.rowInset,
    paddingTop: SETTINGS.rowVertical
  },
  close: {
    marginTop: SETTINGS.rowVertical,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: SETTINGS.separator,
    alignItems: 'center',
    paddingVertical: SETTINGS.rowVertical + 2
  },
  closeText: {
    color: SETTINGS.blue,
    fontSize: SETTINGS.body,
    fontWeight: '600'
  }
})
