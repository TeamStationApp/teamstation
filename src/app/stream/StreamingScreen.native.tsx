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
  type PhoneStream,
  phoneStream,
  PhoneStreamError,
  PhoneStreamPreview,
  type PhoneZoomScale,
  usePhoneStreamStatusOf,
  useRadarStateOf
} from './phoneStream'

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
  /** The gear. The settings sheet arrives with M12; until then it opens nothing. */
  onOpenSettings?: () => void
  /** The engine; a test hands in one over a stand-in module. */
  phone?: PhoneStream
  /** Android's landscape lock; a test hands in its own. */
  rotation?: { lockLandscape: () => void; restore: () => void }
}

/** How many times a one-pill rail is read again while the camera starts. */
const SCALE_READS = 10

/** Android's `TSOrientation`; iOS turns the modal by `supportedOrientations`. */
const androidRotation = orientationLock(
  Platform.OS,
  NativeModules.TSOrientation as NativeOrientation | undefined
)

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
 * A landscape-only `Modal` (iOS turns it by `supportedOrientations`, Android
 * holds the activity sideways), with the phone kept awake while it is up: the
 * engine is opened when it appears and closed when it goes. The picture is the
 * camera itself, without the stream's delay. Pinch zooms, and so does a
 * vertical drag that starts level with the zoom rail.
 *
 * Record starts the recording and the stream together, on the stream URL the
 * server gave this phone for the angle; stopping takes a slide. The first time
 * a recording stops, the server is told this phone holds it, which starts the
 * upload reminder.
 */
export function StreamingScreen(
  props: StreamingScreenProps
): React.ReactElement {
  const { onClose } = props
  return (
    <Modal
      visible
      animationType="fade"
      presentationStyle="fullScreen"
      supportedOrientations={['landscape-left', 'landscape-right']}
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={() => {
        // Android's back: the same as Close, and refused the same way while
        // recording.
        onClose()
      }}
    >
      <StatusBar hidden />
      {/* The modal's own safe area: the app's is the upright root's. */}
      <SafeAreaProvider>
        <StreamingOverlay {...props} />
      </SafeAreaProvider>
    </Modal>
  )
}

function StreamingOverlay(props: StreamingScreenProps): React.ReactElement {
  const {
    client,
    session,
    deviceId,
    deviceModel,
    onClose,
    onOpenSettings,
    phone = phoneStream,
    rotation = androidRotation
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
  const recording = status?.isRecording ?? recordingHere
  // Told once: the server keeps its reminder from the first.
  const reported = useRef(
    session.localRecording === 'recorded' ||
      session.localRecording === 'uploaded'
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

  // The engine is open while the screen is up, and the phone held sideways.
  useEffect(() => {
    let live = true
    rotation.lockLandscape()
    closing
      .then(async () => {
        await phone.open(session.angleName)
      })
      .then(
        () => {
          if (live) readScale()
        },
        (error: unknown) => {
          if (live) setProblem(describeRefusal(error, session.angleName))
        }
      )
    return () => {
      live = false
      closing = phone.close().catch(() => {})
      rotation.restore()
    }
    // One engine session per screen: the angle is renamed through it (M12).
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
    if (recording) {
      setConfirmStop(true)
      return
    }
    setBusy(true)
    setProblem(undefined)
    phone
      .startRecording({
        rtmpUrl: session.url,
        liveStreamId: session.streamId,
        gameId: session.gameId,
        angleName: session.angleName,
        request: {
          apiBase: client.baseUrl,
          token: client.token ?? '',
          deviceId,
          deviceModel
        }
      })
      .then(
        () => {
          setRecordingHere(true)
        },
        (error: unknown) => {
          setProblem(describeRefusal(error, session.angleName))
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
          if (reported.current) return
          reported.current = true
          client
            .updateLiveStream(session.gameId, session.streamId, {
              localRecording: 'recorded'
            })
            .catch(() => {
              // Said again at the next stop.
              reported.current = false
            })
        },
        (error: unknown) => {
          setProblem(describeRefusal(error, session.angleName))
        }
      )
      .finally(() => {
        setBusy(false)
      })
  }, [client, phone, session])

  const flip = (): void => {
    phone.flip().then(
      () => {
        setFront(value => !value)
        setScaleReads(0)
        readScale()
      },
      (error: unknown) => {
        setProblem(describeRefusal(error, session.angleName))
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
          disabled={recording}
          onPress={() => {
            if (!recording) onClose()
          }}
        />
        <OverlayButton
          glyph="settings"
          testID="settings-button"
          accessibilityLabel={lstrings.stream_settings}
          onPress={() => {
            onOpenSettings?.()
          }}
        />
        <NameBadge name={session.angleName} />
      </View>

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

      {confirmStop && recording ? (
        <Pressable
          testID="slide-to-stop-dismiss"
          style={StyleSheet.absoluteFill}
          onPress={() => {
            setConfirmStop(false)
          }}
        />
      ) : null}
      <View pointerEvents="box-none" style={styles.bottom}>
        {confirmStop && recording ? (
          <SlideToStop onStop={stop} />
        ) : (
          <RecordButton
            recording={recording}
            disabled={busy}
            onPress={record}
          />
        )}
      </View>
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
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    // From the glass, as TS Cameraman places it, not from the home indicator.
    bottom: RECORD.bottom,
    alignItems: 'center'
  }
})
