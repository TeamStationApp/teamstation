import React, { useEffect, useState } from 'react'
import {
  Modal,
  NativeModules,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  useWindowDimensions,
  View
} from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import type { TeamStationClient } from '../../../common/api'
import { useInsets } from '../../platform/safeArea'
import {
  type NativeOrientation,
  orientationLock
} from '../../player/multiCam/orientationLock'
import { angleNameProblem, angleNameToSend } from '../AngleNamePrompt'
import type { PhoneLens, PhoneStream, RadarState } from '../phoneStreamClient'
import { ALL_ORIENTATIONS, PairDeviceModal } from './PairDeviceModal'
import { RadarCard } from './RadarCard'
import { SettingsCard } from './SettingsCard'
import { cardColumns, settingsColumns } from './settingsLayout'
import { settingsStrings as words } from './settingsStrings'
import { SETTINGS } from './settingsTheme'

/** What Done applied, for the streaming screen to keep. */
export interface AppliedSettings {
  angleName: string
  audioEnabled: boolean
}

export interface StreamSettingsSheetProps {
  client: TeamStationClient
  gameId: string
  streamId: string
  /** The angle's name now, which the Name card starts from. */
  angleName: string
  /** Whether the microphone is on now: the engine does not say. */
  audioEnabled: boolean
  phone: PhoneStream
  radar: RadarState | null
  /** The server took the new name: the badge shows it from now on. */
  onRenamed: (angleName: string) => void
  /** Done, once everything it changed is applied. */
  onDone: (applied: AppliedSettings) => void
  /** Android's back: the sheet goes, and nothing in it is applied. */
  onCancel: () => void
  /** Android's rotation; a test hands in its own. */
  rotation?: { allow: () => void; lockLandscape: () => void }
}

/** Android's `TSOrientation`; iOS turns the modal by `supportedOrientations`. */
const androidRotation = orientationLock(
  Platform.OS,
  NativeModules.TSOrientation as NativeOrientation | undefined
)

/** A lens as its row names it: millimetres, then which side of the phone. */
export function lensLabel(lens: PhoneLens): string {
  return `${lens.title} · ${lens.position === 'front' ? 'Front' : 'Back'}`
}

/**
 * Whether a lens's switch may be moved: on may always be turned off while
 * another lens stays on, and off may always be turned on, so the camera is
 * never left with none.
 */
export function lensToggleable(
  lens: PhoneLens,
  lenses: PhoneLens[],
  disabled: ReadonlySet<string>
): boolean {
  if (disabled.has(lens.id)) return true
  return lenses.some(other => other.id !== lens.id && !disabled.has(other.id))
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean =>
  a.size === b.size && [...a].every(id => b.has(id))

/**
 * The gear's sheet: the camera's settings, in TS Cameraman's cards.
 *
 * Audio, Lenses, Name and Radar, in that order: two columns in landscape on a
 * window at least 600 wide, one otherwise. The sheet turns with the phone
 * (every orientation on iOS; on Android the activity is let turn while it is
 * up and held sideways again when it goes).
 *
 * The microphone, the lenses and the name are drafts until Done: Done turns
 * the microphone and the lenses as set, renames the angle on the server and
 * then in the engine, and closes. A name the server refuses, such as one
 * already on another of this person's cameras on the game, is shown under the
 * field, the sheet stays up, the angle keeps its old name and nothing else is
 * applied. The radar acts
 * at once, as Cameraman's does.
 *
 * Not here, unlike Cameraman: sign-in, the codec, resolution and bitrate,
 * clean HDMI, the stream address, the scoreboard and the thermal test. The
 * phone's stream is the server's, at the profile the engine sets.
 */
export function StreamSettingsSheet(
  props: StreamSettingsSheetProps
): React.ReactElement {
  const { onCancel, rotation = androidRotation } = props
  useEffect(() => {
    rotation.allow()
    return () => {
      rotation.lockLandscape()
    }
    // Once a sheet: the lock the streaming screen holds comes back after it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      supportedOrientations={ALL_ORIENTATIONS}
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onCancel}
    >
      <StatusBar hidden />
      <SafeAreaProvider>
        <SheetBody {...props} />
      </SafeAreaProvider>
    </Modal>
  )
}

function SheetBody(
  props: Omit<StreamSettingsSheetProps, 'onCancel' | 'rotation'>
): React.ReactElement {
  const { client, gameId, streamId, phone, radar, onDone, onRenamed } = props
  const insets = useInsets()
  const window = useWindowDimensions()
  const [audio, setAudio] = useState(props.audioEnabled)
  const [lenses, setLenses] = useState<PhoneLens[]>([])
  const [disabledAtOpen, setDisabledAtOpen] = useState<ReadonlySet<string>>(
    new Set()
  )
  const [disabled, setDisabled] = useState<ReadonlySet<string>>(new Set())
  const [name, setName] = useState(props.angleName)
  const [refused, setRefused] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [pairing, setPairing] = useState(false)

  useEffect(() => {
    let live = true
    phone.lenses().then(
      found => {
        if (!live) return
        const off = new Set(
          found.filter(lens => !lens.enabled).map(lens => lens.id)
        )
        setLenses(found)
        setDisabledAtOpen(off)
        setDisabled(off)
      },
      () => {}
    )
    return () => {
      live = false
    }
  }, [phone])

  const nameProblem = angleNameProblem(name)

  const done = async (): Promise<void> => {
    if (busy || nameProblem != null) return
    setBusy(true)
    setRefused(undefined)
    try {
      // The name first: it is the one change the server may refuse, and a
      // refusal leaves everything as it was.
      let angleName = props.angleName
      const wanted = angleNameToSend(name)
      if (wanted != null && wanted !== props.angleName) {
        const renamed = await client.updateLiveStream(gameId, streamId, {
          label: wanted
        })
        angleName = renamed.label !== '' ? renamed.label : wanted
        onRenamed(angleName)
        await phone.setAngleName(angleName)
      }
      if (audio !== props.audioEnabled) await phone.setAudioEnabled(audio)
      if (!sameSet(disabled, disabledAtOpen))
        await phone.setDisabledLenses([...disabled])
      onDone({ angleName, audioEnabled: audio })
    } catch (error) {
      setRefused(error instanceof Error ? error.message : String(error))
      setBusy(false)
    }
  }

  const audioCard = (
    <SettingsCard key="audio" title={words.audio} testID="settings-audio-card">
      <View style={[styles.row, styles.switchRow]}>
        <Text style={styles.label}>{words.microphone}</Text>
        <Switch
          testID="settings-audio"
          accessibilityLabel={words.microphone}
          value={audio}
          onValueChange={setAudio}
        />
      </View>
    </SettingsCard>
  )

  const lensesCard = (
    <SettingsCard
      key="lenses"
      title={words.lenses}
      testID="settings-lenses-card"
    >
      {lenses.length === 0 ? (
        <Text style={[styles.row, styles.secondary]}>{words.lensesNone}</Text>
      ) : (
        lenses.map((lens, index) => (
          <View key={lens.id}>
            {index > 0 ? <View style={styles.separator} /> : null}
            <View style={[styles.row, styles.switchRow]}>
              <Text style={styles.label} numberOfLines={1}>
                {lensLabel(lens)}
              </Text>
              <Switch
                testID={`settings-lens-${index}`}
                accessibilityLabel={lensLabel(lens)}
                accessibilityHint={lens.subtitle}
                value={!disabled.has(lens.id)}
                disabled={!lensToggleable(lens, lenses, disabled)}
                onValueChange={on => {
                  setDisabled(current => {
                    const next = new Set(current)
                    if (on) next.delete(lens.id)
                    else if (lensToggleable(lens, lenses, current))
                      next.add(lens.id)
                    return next
                  })
                }}
              />
            </View>
          </View>
        ))
      )}
    </SettingsCard>
  )

  const nameCard = (
    <SettingsCard key="name" title={words.name} testID="settings-name-card">
      <View style={styles.row}>
        <TextInput
          testID="settings-name"
          accessibilityLabel={words.nameLabel}
          value={name}
          onChangeText={text => {
            setName(text)
            setRefused(undefined)
          }}
          placeholder={props.angleName}
          placeholderTextColor={SETTINGS.secondaryText}
          autoCorrect={false}
          returnKeyType="done"
          style={styles.input}
        />
      </View>
      {nameProblem != null || refused != null ? (
        <Text testID="settings-name-error" style={[styles.row, styles.error]}>
          {nameProblem ?? refused}
        </Text>
      ) : null}
    </SettingsCard>
  )

  const radarCard = (
    <RadarCard
      key="radar"
      phone={phone}
      radar={radar}
      onPair={() => {
        setPairing(true)
      }}
    />
  )

  const columns = settingsColumns(window.width, window.height)
  return (
    <View
      style={[
        styles.screen,
        { paddingLeft: insets.left, paddingRight: insets.right }
      ]}
      testID={
        columns === 2 ? 'settings-layout-landscape' : 'settings-layout-portrait'
      }
    >
      <View style={[styles.toolbar, { marginTop: insets.top }]}>
        <Text style={styles.toolbarTitle}>{words.title}</Text>
        <Pressable
          testID="settings-done"
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          hitSlop={8}
          style={styles.done}
          onPress={() => {
            done().catch(() => {})
          }}
        >
          <Text style={styles.doneText}>{words.done}</Text>
        </Pressable>
      </View>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[
          styles.content,
          { paddingBottom: insets.bottom + SETTINGS.gap * 2 }
        ]}
      >
        {cardColumns([audioCard, lensesCard, nameCard, radarCard], columns).map(
          (cards, index) => (
            <View key={index} style={styles.column}>
              {cards}
            </View>
          )
        )}
      </ScrollView>
      {pairing ? (
        <PairDeviceModal
          phone={phone}
          radar={radar}
          onClose={() => {
            setPairing(false)
          }}
        />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: SETTINGS.background
  },
  toolbar: {
    height: SETTINGS.toolbarHeight,
    alignItems: 'center',
    justifyContent: 'center'
  },
  toolbarTitle: {
    color: SETTINGS.text,
    fontSize: SETTINGS.body,
    fontWeight: '600'
  },
  done: {
    position: 'absolute',
    right: SETTINGS.gap,
    top: 0,
    bottom: 0,
    justifyContent: 'center'
  },
  doneText: {
    color: SETTINGS.green,
    fontSize: SETTINGS.body,
    fontWeight: '600'
  },
  content: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SETTINGS.gap,
    paddingHorizontal: SETTINGS.margin,
    paddingTop: SETTINGS.rowVertical
  },
  column: {
    flex: 1,
    gap: SETTINGS.gap
  },
  row: {
    paddingHorizontal: SETTINGS.rowInset,
    paddingVertical: SETTINGS.rowVertical
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12
  },
  label: {
    flexShrink: 1,
    color: SETTINGS.text,
    fontSize: SETTINGS.body
  },
  secondary: {
    color: SETTINGS.secondaryText,
    fontSize: SETTINGS.footnote
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    marginLeft: SETTINGS.rowInset,
    backgroundColor: SETTINGS.separator
  },
  input: {
    color: SETTINGS.text,
    fontSize: SETTINGS.body,
    backgroundColor: SETTINGS.inputBackground,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  error: {
    color: SETTINGS.red,
    fontSize: SETTINGS.footnote,
    paddingTop: 0
  }
})
