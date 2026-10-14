import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Modal,
  NativeModules,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View
} from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import type { TeamStationClient } from '../../common/api'
import { lstrings, sprintf } from '../locales/strings'
import { useInsets } from '../platform/safeArea'
import {
  type NativeOrientation,
  orientationLock
} from '../player/multiCam/orientationLock'
import { applyCameraOrientation } from './cameraOrientation'
import { BatteryBadge } from './overlay/BatteryBadge'
import { NameBadge } from './overlay/NameBadge'
import { OverlayButton } from './overlay/OverlayButton'
import {
  BUTTON_SIZE,
  EDGE_INSET,
  ENDED_RED,
  RAIL_TRAILING,
  RECORD,
  ROW_SPACING,
  WHITE
} from './overlay/overlayTheme'
import { RadarReadout } from './overlay/RadarReadout'
import { RecordButton } from './overlay/RecordButton'
import { SlideToStop } from './overlay/SlideToStop'
import { StreamStatusPill } from './overlay/StreamStatusPill'
import { ThermalBadge } from './overlay/ThermalBadge'
import {
  type RailBand,
  zoomGesture,
  zoomRailResponder,
  zoomResponder
} from './overlay/zoomGestures'
import { ZoomScale } from './overlay/ZoomScale'
import {
  CAMERA_UNAVAILABLE,
  cameraUnavailable,
  type PhoneStream,
  phoneStream,
  PhoneStreamError,
  PhoneStreamPreview,
  type PhoneZoomScale,
  usePhoneStreamStatusOf,
  useRadarStateOf
} from './phoneStream'
import {
  type OpenPublisherSocket,
  useScoreboardRadarPublisher
} from './scoreboardRadarPublisher'
import {
  CAMERA_ORIENTATIONS,
  SETTINGS_ORIENTATIONS
} from './settings/PairDeviceModal'
import { StreamSettingsSheet } from './settings/StreamSettingsSheet'

/** The stream this phone holds for one angle, as `POST …/live-streams` gave it. */
export interface StreamingSession {
  gameId: string
  streamId: string
  /** The RTMP address with its key, which the engine dials. */
  url: string
  angleName: string
  /** What the server last said of this phone's recording of it. */
  localRecording?: 'none' | 'recorded' | 'uploaded'
}

export interface StreamingScreenProps {
  client: TeamStationClient
  session: StreamingSession
  /** This install's id and model, which the engine's own redial sends. */
  deviceId: string
  deviceModel: string
  onClose: () => void
  /** The engine; a test hands in one over a stand-in module. */
  phone?: PhoneStream
  /**
   * Android's rotation: held sideways while the camera is up, turned by the
   * sensor while settings is open, and stood upright again when the camera
   * closes. A test hands in its own.
   */
  rotation?: {
    allow?: () => void
    lockLandscape: () => void
    restore: () => void
  }
  /**
   * iOS geometry for the camera view. A test hands in its own; the default
   * asks the root controller, which is what overrides a portrait lock.
   */
  cameraOrientation?: {
    landscape: () => void
    any: () => void
    portrait: () => void
  }
  /** The scoreboard's socket; a test hands in its own. */
  openScoreboardSocket?: OpenPublisherSocket
}

/** How many times a one-pill rail is read again while the camera starts. */
const SCALE_READS = 10

/** Android's `TSOrientation`. iOS uses `applyCameraOrientation`. */
const androidLock = orientationLock(
  Platform.OS,
  NativeModules.TSOrientation as NativeOrientation | undefined
)

/**
 * Sideways for the camera, by the sensor for settings (whatever the phone's
 * rotation lock says), and upright again when the camera closes.
 */
const androidRotation = {
  allow: androidLock.followSensor,
  lockLandscape: androidLock.lockLandscape,
  restore: androidLock.restore
}

const defaultCameraOrientation = {
  landscape: () => {
    applyCameraOrientation(
      Platform.OS,
      NativeModules.TSOrientation as NativeOrientation | undefined,
      'landscape'
    )
  },
  any: () => {
    applyCameraOrientation(
      Platform.OS,
      NativeModules.TSOrientation as NativeOrientation | undefined,
      'any'
    )
  },
  portrait: () => {
    applyCameraOrientation(
      Platform.OS,
      NativeModules.TSOrientation as NativeOrientation | undefined,
      'portrait'
    )
  }
}

/**
 * The engine's last close, which the next open waits for: a screen closed and
 * opened again at once must not open the engine before the close has run.
 */
let closing: Promise<void> = Promise.resolve()

/** What a refusal from the engine says to the person holding the phone. */
export function describeRefusal(error: unknown, angleName: string): string {
  if (error instanceof PhoneStreamError) {
    if (error.code === 'permission') return lstrings.stream_error_permission
    if (error.code === 'insufficientStorage')
      return lstrings.stream_error_storage
    if (error.code === 'uploadInProgress')
      return sprintf(lstrings.stream_error_uploading, angleName)
    if (error.code === CAMERA_UNAVAILABLE)
      return lstrings.stream_camera_unavailable
  }
  return sprintf(
    lstrings.stream_error_failed,
    error instanceof Error ? error.message : String(error)
  )
}

/**
 * The camera, full screen and sideways, with TS Cameraman's chrome over it:
 * what Record video opens.
 *
 * A landscape-only `Modal`. iOS also reports landscape from the app delegate
 * while this screen is up, and Android holds the activity sideways, so the
 * camera can flip upside down and cannot stand upright. Settings widens that
 * hold and may stand upright or lie sideways; closing it locks landscape again.
 * The phone is kept awake while the camera is up: the
 * engine is opened when it appears and closed when it goes. The picture is the
 * camera itself, without the stream's delay. Pinch zooms, and so does a
 * vertical drag that starts level with the zoom rail.
 *
 * Record starts the recording and the stream together, on the stream URL the
 * server gave this phone for the angle; stopping takes a slide, and Close and
 * Android's back are held while either runs. The first time a part ends, the
 * server is told this phone holds a recording, which starts the upload
 * reminder. Opened again after a kill on the stream whose take was rolling,
 * it carries that take on.
 *
 * The gear opens the settings sheet (microphone, lenses, the angle's name,
 * radars). While a radar is paired, its readings go to the game's scoreboard.
 */
export function StreamingScreen(
  props: StreamingScreenProps
): React.ReactElement {
  const { onClose } = props
  /** Whether the overlay is recording or streaming, which holds Close. */
  const holding = useRef(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  return (
    <Modal
      visible
      animationType="fade"
      presentationStyle="fullScreen"
      supportedOrientations={
        settingsOpen ? SETTINGS_ORIENTATIONS : CAMERA_ORIENTATIONS
      }
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={() => {
        // Android's back: the same as Close, and refused the same way while
        // recording or streaming, since closing the engine would stop both.
        if (!holding.current) onClose()
      }}
    >
      <StatusBar hidden />
      {/* The modal's own safe area: the app's is the upright root's. */}
      <SafeAreaProvider>
        <StreamingOverlay
          {...props}
          holding={holding}
          settingsOpen={settingsOpen}
          setSettingsOpen={setSettingsOpen}
        />
      </SafeAreaProvider>
    </Modal>
  )
}

function StreamingOverlay(
  props: StreamingScreenProps & {
    holding: React.RefObject<boolean>
    settingsOpen: boolean
    setSettingsOpen: (open: boolean) => void
  }
): React.ReactElement {
  const {
    client,
    session,
    deviceId,
    deviceModel,
    onClose,
    phone = phoneStream,
    rotation = androidRotation,
    cameraOrientation = defaultCameraOrientation,
    openScoreboardSocket,
    settingsOpen,
    setSettingsOpen
  } = props
  const insets = useInsets()
  const window = useWindowDimensions()
  const status = usePhoneStreamStatusOf(phone)
  const radar = useRadarStateOf(phone)
  const [scale, setScale] = useState<PhoneZoomScale | null>(null)
  const [front, setFront] = useState(false)
  const [recordingHere, setRecordingHere] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | undefined>(undefined)
  /** The angle's name: Record video's, until the settings sheet renames it. */
  const [angleName, setAngleName] = useState(session.angleName)
  /** The microphone, which the settings sheet turns off and on. */
  const [audioEnabled, setAudioEnabled] = useState(true)
  const recording = status?.isRecording ?? recordingHere
  // The stream can outlive its recording's part — the part stops when the
  // phone runs low on space and the stream goes on — and Record cannot start
  // while it does, so the stop control and the hold on Close follow either.
  const streaming = status != null && status.phase !== 'idle'
  const holding = recording || streaming
  props.holding.current = holding
  // The camera is lost (Android says so; iOS may not): the engine refuses
  // Record until it is back, so Record is not offered meanwhile. A recording
  // or stream already running can still be stopped.
  const cameraLost = cameraUnavailable(status)
  // The game's scoreboard hears each radar reading while a radar is paired.
  useScoreboardRadarPublisher({
    apiBase: client.baseUrl,
    gameId: session.gameId,
    token: client.token,
    radar,
    open: openScoreboardSocket
  })
  // Told once: the server keeps its reminder from the first.
  const reported = useRef(
    session.localRecording === 'recorded' ||
      session.localRecording === 'uploaded'
  )
  /** Tells the server this phone holds a recording of the angle, once. */
  const report = useCallback(() => {
    if (reported.current) return
    reported.current = true
    client
      .updateLiveStream(session.gameId, session.streamId, {
        localRecording: 'recorded'
      })
      .catch(() => {
        // Said again when the next part ends, and, after the last part, by
        // `useResumePendingUploads` when the app next opens or comes back.
        reported.current = false
      })
  }, [client, session])
  // Whenever a part ends — a slide to stop, a low-storage stop, the app
  // going to the background — the phone holds a recording.
  const wasRecording = useRef(false)
  const isRecordingNow = status?.isRecording
  useEffect(() => {
    if (isRecordingNow == null) return
    if (wasRecording.current && !isRecordingNow) report()
    wasRecording.current = isRecordingNow
  }, [isRecordingNow, report])

  /** What the engine's redial sends to ask for this device's stream again. */
  const redialRequest = useMemo(
    () => ({
      apiBase: client.baseUrl,
      token: client.token ?? '',
      deviceId,
      deviceModel
    }),
    [client, deviceId, deviceModel]
  )

  const readScale = useCallback(() => {
    phone.zoomScale().then(setScale, () => {})
  }, [phone])
  // The lenses are found once the camera is running, a moment after the
  // engine opens: until the rail has more than one pill, read it again each
  // second for a while. A camera with one fixed zoom stops asking.
  const [scaleReads, setScaleReads] = useState(0)
  useEffect(() => {
    if (scale == null || scale.presets.length > 1 || scaleReads >= SCALE_READS)
      return
    const timer = setTimeout(() => {
      setScaleReads(reads => reads + 1)
      readScale()
    }, 1000)
    return () => {
      clearTimeout(timer)
    }
  }, [readScale, scale, scaleReads])

  // True while this screen's cleanup has not run. The settings sheet asks
  // this before it locks landscape again, so a sheet that unmounts after the
  // screen cannot turn the phone back sideways.
  const cameraHeld = useRef(false)
  // The engine is open while the screen is up, and the phone held sideways.
  // Opened again after a kill or a crash, within the hour, on the stream
  // whose take was rolling, the take continues as its next part and the
  // stream redials.
  useEffect(() => {
    let live = true
    cameraHeld.current = true
    rotation.lockLandscape()
    cameraOrientation.landscape()
    const opened = closing.then(async () => {
      await phone.open(session.angleName)
    })
    opened
      .then(async () => {
        if (!live) return
        readScale()
        const interrupted = await phone.interruptedSession()
        if (!live || interrupted?.liveStreamId !== session.streamId) return
        if (await phone.resumeInterrupted(redialRequest)) setRecordingHere(true)
      })
      .catch((error: unknown) => {
        if (live) setProblem(describeRefusal(error, session.angleName))
      })
    return () => {
      live = false
      cameraHeld.current = false
      // After the open, never before it: a screen gone before the engine
      // finished opening must not leave the camera running behind it.
      closing = opened
        .catch(() => {})
        .then(async () => {
          await phone.close()
        })
        .catch(() => {})
      rotation.restore()
      cameraOrientation.portrait()
    }
    // One engine session per screen: the settings sheet renames the angle through it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phone])

  const displayed = status?.displayedZoom ?? scale?.current ?? 1
  const rail = useRef<{ band: RailBand | null; pointsPerSegment: number }>({
    band: null,
    pointsPerSegment: 72
  })
  const live = useRef({ scale, displayed, height: window.height })
  live.current = { scale, displayed, height: window.height }
  const zoom = useMemo(
    () =>
      zoomGesture({
        pinch: (value, ended) => {
          phone.pinch(value, ended)
        },
        setZoom: value => {
          phone.setZoom(value)
        },
        scale: () => live.current.scale,
        displayed: () => live.current.displayed,
        railBand: () => rail.current.band,
        pointsPerSegment: () => rail.current.pointsPerSegment,
        screenHeight: () => live.current.height
      }),
    [phone]
  )
  const gesture = useMemo(() => zoomResponder(zoom), [zoom])
  // The rail's pills take taps; a drag that starts on one still zooms.
  const railGesture = useMemo(() => zoomRailResponder(zoom), [zoom])

  const record = (): void => {
    if (holding) {
      setConfirmStop(true)
      return
    }
    if (cameraLost) return
    setBusy(true)
    setProblem(undefined)
    phone
      .startRecording({
        rtmpUrl: session.url,
        liveStreamId: session.streamId,
        gameId: session.gameId,
        angleName,
        request: redialRequest
      })
      .then(
        () => {
          setRecordingHere(true)
        },
        (error: unknown) => {
          setProblem(describeRefusal(error, angleName))
        }
      )
      .finally(() => {
        setBusy(false)
      })
  }

  const stop = useCallback(() => {
    setConfirmStop(false)
    setBusy(true)
    phone
      .stopRecording()
      .then(
        () => {
          setRecordingHere(false)
          report()
        },
        (error: unknown) => {
          setProblem(describeRefusal(error, angleName))
        }
      )
      .finally(() => {
        setBusy(false)
      })
  }, [angleName, phone, report])

  const flip = (): void => {
    phone.flip().then(
      () => {
        setFront(value => !value)
        setScaleReads(0)
        readScale()
      },
      (error: unknown) => {
        setProblem(describeRefusal(error, angleName))
      }
    )
  }

  const top = insets.top + EDGE_INSET
  return (
    <View style={styles.screen}>
      <PhoneStreamPreview style={StyleSheet.absoluteFill} mirrored={front} />
      <View
        testID="camera-screen"
        style={StyleSheet.absoluteFill}
        {...gesture}
      />

      <View
        pointerEvents="box-none"
        style={[
          styles.topLeft,
          {
            top,
            left: insets.left + EDGE_INSET,
            maxWidth: window.width / 2 - insets.left - EDGE_INSET
          }
        ]}
      >
        <OverlayButton
          glyph="close"
          testID="camera-close"
          accessibilityLabel={lstrings.stream_close}
          disabled={holding}
          onPress={() => {
            if (!holding) onClose()
          }}
        />
        <OverlayButton
          glyph="settings"
          testID="settings-button"
          accessibilityLabel={lstrings.stream_settings}
          onPress={() => {
            setSettingsOpen(true)
          }}
        />
        <NameBadge name={angleName} />
      </View>

      {cameraLost ? (
        <Text
          testID="camera-unavailable"
          style={[
            styles.unavailable,
            { top: window.height / 2 - BUTTON_SIZE / 2 }
          ]}
        >
          {lstrings.stream_camera_unavailable}
        </Text>
      ) : null}

      {problem != null ? (
        <Text
          testID="stream-problem"
          style={[
            styles.problem,
            {
              top: top + BUTTON_SIZE + ROW_SPACING,
              left: insets.left + EDGE_INSET,
              maxWidth: window.width / 2
            }
          ]}
        >
          {problem}
        </Text>
      ) : null}

      <View
        pointerEvents="box-none"
        style={[
          styles.right,
          {
            top,
            bottom: insets.bottom + EDGE_INSET,
            right: insets.right + RAIL_TRAILING
          }
        ]}
      >
        <View pointerEvents="none" style={styles.pills}>
          <StreamStatusPill status={status} />
          <ThermalBadge level={status?.thermal ?? 'cool'} />
          {status?.batteryPercent != null ? (
            <BatteryBadge
              percent={status.batteryPercent}
              charging={status.charging}
            />
          ) : null}
        </View>
        {scale != null ? (
          <ZoomScale
            scale={scale}
            displayed={displayed}
            onSelect={value => {
              phone.setZoom(value)
            }}
            onRail={(band, pointsPerSegment) => {
              rail.current = { band, pointsPerSegment }
            }}
            railResponder={railGesture}
          />
        ) : null}
      </View>

      <View
        pointerEvents="box-none"
        style={[
          styles.flip,
          {
            left: insets.left + EDGE_INSET,
            bottom: insets.bottom + EDGE_INSET
          }
        ]}
      >
        <OverlayButton
          glyph="flip"
          testID="flip-button"
          accessibilityLabel={lstrings.stream_flip}
          onPress={flip}
        />
      </View>

      <RadarReadout radar={radar} bottom={insets.bottom} right={insets.right} />

      {confirmStop && holding ? (
        <Pressable
          testID="slide-to-stop-dismiss"
          style={StyleSheet.absoluteFill}
          onPress={() => {
            setConfirmStop(false)
          }}
        />
      ) : null}
      <View pointerEvents="box-none" style={styles.bottom}>
        {confirmStop && holding ? (
          <SlideToStop onStop={stop} />
        ) : (
          <RecordButton
            recording={holding}
            disabled={busy || (cameraLost && !holding)}
            onPress={record}
          />
        )}
      </View>

      {settingsOpen ? (
        <StreamSettingsSheet
          client={client}
          gameId={session.gameId}
          streamId={session.streamId}
          angleName={angleName}
          audioEnabled={audioEnabled}
          phone={phone}
          radar={radar}
          rotation={{
            allow: () => {
              rotation.allow?.()
            },
            lockLandscape: rotation.lockLandscape
          }}
          cameraOrientation={cameraOrientation}
          releaseLandscape={() => {
            if (!cameraHeld.current) return
            rotation.lockLandscape()
            cameraOrientation.landscape()
          }}
          onRenamed={setAngleName}
          onDone={applied => {
            setAngleName(applied.angleName)
            setAudioEnabled(applied.audioEnabled)
            setSettingsOpen(false)
          }}
          onCancel={() => {
            setSettingsOpen(false)
          }}
        />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#000000'
  },
  topLeft: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    gap: ROW_SPACING
  },
  problem: {
    position: 'absolute',
    color: WHITE,
    fontSize: 15,
    fontWeight: '600',
    backgroundColor: ENDED_RED,
    borderRadius: 10,
    overflow: 'hidden',
    paddingHorizontal: 12,
    paddingVertical: 8
  },
  right: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: ROW_SPACING
  },
  pills: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: ROW_SPACING
  },
  flip: {
    position: 'absolute'
  },
  unavailable: {
    position: 'absolute',
    alignSelf: 'center',
    color: WHITE,
    fontSize: 17,
    fontWeight: '700',
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderRadius: 10,
    overflow: 'hidden',
    paddingHorizontal: 16,
    paddingVertical: 10
  },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    // From the glass, as TS Cameraman places it, not from the home indicator.
    bottom: RECORD.bottom,
    alignItems: 'center'
  }
})
