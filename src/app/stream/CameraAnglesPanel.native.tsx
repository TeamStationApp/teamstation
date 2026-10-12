import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Platform, Pressable, Text, View } from 'react-native'

import type {
  GameLiveStreams,
  LiveStream,
  TeamStationClient
} from '../../common/api'
import { Button } from '../components/Button'
import { SectionHeader } from '../components/SectionHeader'
import { streamActionsFor } from '../components/streamActions'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { AngleNamePrompt } from './AngleNamePrompt'
import { deviceId as installId } from './deviceId'
import {
  type PhoneRecording,
  type PhoneStream,
  phoneStream,
  type PhoneStreamCapabilities,
  type UploadProgress,
  useRecordingsOf
} from './phoneStream'
import { RecordingUploadRow, uploadRowState } from './RecordingUploadRow'
import { StreamActionSheet } from './StreamActionSheet'
import {
  StreamingScreen,
  type StreamingSession
} from './StreamingScreen.native'

/** How often the game's cameras are read again while the panel is up. */
export const ANGLES_POLL_MS = 5000

export interface CameraAnglesPanelProps {
  client: TeamStationClient
  gameId: string
  /** The engine; a test hands in one over a stand-in module. */
  phone?: PhoneStream
  /** This install's id; a test hands in its own. */
  deviceId?: () => Promise<string>
  /** The streaming screen, which a test may replace. */
  Screen?: typeof StreamingScreen
  /** The clipboard; a test hands in its own. */
  copy?: (text: string) => void
}

interface OpenCamera {
  session: StreamingSession
  id: string
}

/** The game's cameras, each marked whether it is the caller's own. */
function anglesOf(
  streams: GameLiveStreams | undefined
): Array<{ stream: LiveStream; mine: boolean }> {
  if (streams == null) return []
  return [
    ...streams.mine.map(stream => ({ stream, mine: true })),
    ...streams.others.map(stream => ({ stream, mine: false }))
  ]
}

/** The chip's word: Live while video arrives, Ended once it was ended. */
export function angleState(stream: LiveStream): 'live' | 'idle' | 'ended' {
  if (stream.state === 'publishing') return 'live'
  if (stream.state === 'ended') return 'ended'
  if (stream.closesAt != null && Date.parse(stream.closesAt) <= Date.now())
    return 'ended'
  return 'idle'
}

/**
 * Whether a take is being uploaded, or was cut off in its upload: it then
 * takes no new part, so its angle cannot be recorded again until it lands.
 */
function isUploading(
  recording: PhoneRecording,
  progress: UploadProgress | undefined,
  cancelled: boolean
): boolean {
  if (recording.uploadedAt != null || cancelled) return false
  if (recording.hasPendingUpload || recording.uploadRunning) return true
  return (
    progress != null &&
    progress.state !== 'failed' &&
    progress.state !== 'uploaded'
  )
}

/**
 * The phone's "Cameras" on a game's Videos tab.
 *
 * - A row for every camera on the game, the caller's and other people's: its
 *   angle, the device filming it, and whether it is live. This phone's own
 *   rows open the camera again; a camera the caller may manage has a "…" with
 *   the web panel's actions.
 * - A row for every take on this phone that TeamStation does not have yet,
 *   with Upload Recording.
 * - Record video, which asks for a camera angle's name, gets this phone's
 *   stream for it from the server and opens the camera.
 *
 * Only the people who may film the game see it: anybody else is answered
 * `404` for the game's cameras and sees nothing, as with the web's panel. A
 * phone that cannot record shows the cameras, without Record video, and
 * nothing at all while there are none.
 */
export function CameraAnglesPanel(
  props: CameraAnglesPanelProps
): React.ReactElement | null {
  const {
    client,
    gameId,
    phone = phoneStream,
    deviceId = installId,
    Screen = StreamingScreen,
    copy
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [allowed, setAllowed] = useState(false)
  const [streams, setStreams] = useState<GameLiveStreams | undefined>(undefined)
  const [myId, setMyId] = useState<string | undefined>(undefined)
  const [capabilities, setCapabilities] = useState<
    PhoneStreamCapabilities | undefined
  >(undefined)
  const { recordings, refresh } = useRecordingsOf(phone)
  /** Each upload's latest word, from the engine or from the press itself. */
  const [progress, setProgress] = useState<Record<string, UploadProgress>>({})
  /** Takes whose upload was cancelled here, back to their button. */
  const [cancelled, setCancelled] = useState<Record<string, true>>({})
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [sheet, setSheet] = useState<
    { stream: LiveStream; mine: boolean } | undefined
  >(undefined)
  const [prompting, setPrompting] = useState(false)
  /** Bumped each time the prompt opens, so it opens empty. */
  const [promptKey, setPromptKey] = useState(0)
  /** The camera to open once the prompt has gone. */
  const [pending, setPending] = useState<OpenCamera | undefined>(undefined)
  const [open, setOpen] = useState<OpenCamera | undefined>(undefined)
  const live = useRef(true)
  const askDeviceId = useRef(deviceId)
  askDeviceId.current = deviceId

  const reload = useCallback(async (): Promise<void> => {
    const next = await client.liveStreams(gameId)
    if (!live.current) return
    setStreams(next)
    setAllowed(true)
  }, [client, gameId])

  useEffect(() => {
    live.current = true
    reload().catch(() => {
      if (live.current) setAllowed(false)
    })
    phone.capabilities().then(
      found => {
        if (live.current) setCapabilities(found)
      },
      () => {}
    )
    askDeviceId.current().then(
      found => {
        if (live.current) setMyId(found)
      },
      () => {}
    )
    return () => {
      live.current = false
    }
  }, [phone, reload])

  // Every five seconds while the panel is up: the cameras, and this phone's
  // takes, so a camera another phone starts appears and a finished upload's
  // row goes.
  useEffect(() => {
    if (!allowed) return
    const timer = setInterval(() => {
      reload().catch(() => undefined)
      refresh()
    }, ANGLES_POLL_MS)
    return () => {
      clearInterval(timer)
    }
  }, [allowed, refresh, reload])

  useEffect(
    () =>
      phone.onUpload(next => {
        setProgress(current => ({ ...current, [next.liveStreamId]: next }))
        if (next.state === 'uploaded') reload().catch(() => undefined)
      }),
    [phone, reload]
  )

  // iOS presents one modal at a time: the camera waits for the prompt to
  // finish leaving (`onDismiss`). Elsewhere it opens at once.
  useEffect(() => {
    if (prompting || pending == null || Platform.OS === 'ios') return
    setOpen(pending)
    setPending(undefined)
  }, [pending, prompting])

  const angles = anglesOf(streams)
  const takes = recordings.filter(
    recording =>
      recording.gameId === gameId &&
      recording.uploadedAt == null &&
      recording.liveStreamId !== open?.session.streamId
  )
  const supported = capabilities?.supported === true
  if (!allowed) return null
  if (!supported && angles.length === 0 && takes.length === 0) return null

  const deviceModel = capabilities?.deviceModel ?? ''
  const uploading = (recording: PhoneRecording): boolean =>
    isUploading(
      recording,
      progress[recording.liveStreamId],
      Object.hasOwn(cancelled, recording.liveStreamId)
    )
  /**
   * A take's angle as it is called now. A rename goes to the server, not to the
   * take this phone holds, so the take's own name is only the fallback for a
   * stream the list no longer has.
   */
  const nameOf = (recording: PhoneRecording): string =>
    angles.find(angle => angle.stream.id === recording.liveStreamId)?.stream
      .label ?? recording.angleName
  /** The take of an angle by this name that is still uploading, if any. */
  const uploadingNamed = (name: string): boolean =>
    recordings.some(
      recording =>
        recording.gameId === gameId &&
        nameOf(recording).toLowerCase() === name.toLowerCase() &&
        uploading(recording)
    )

  /**
   * This phone's stream for an angle: the one it holds under that name, or a
   * new one. Asking without a held stream is what an explicit start is, so a
   * camera somebody ended gets a fresh stream here.
   *
   * `held` is the stream a row stands for. It is asked for by its id, because
   * the name a row shows is not always one the server finds it by: a camera
   * with no stored name is listed by its slot's ("Camera 2").
   */
  const request = async (name: string, held?: string): Promise<OpenCamera> => {
    if (uploadingNamed(name))
      throw new Error(sprintf(lstrings.stream_error_uploading, name))
    const id = myId ?? (await deviceId())
    const stream = await client.addLiveStream(gameId, name, {
      deviceId: id,
      deviceModel,
      recordsLocally: true,
      ...(held == null ? {} : { heldStreamId: held })
    })
    const url =
      stream.url ?? (await client.revealLiveStream(gameId, stream.id)).url
    if (url == null) throw new Error(lstrings.common_retry)
    return {
      id,
      session: {
        gameId,
        streamId: stream.id,
        url,
        angleName: stream.label,
        localRecording: stream.localRecording
      }
    }
  }

  const start = async (name: string): Promise<void> => {
    setPending(await request(name))
    setPrompting(false)
  }

  const reopen = (stream: LiveStream): void => {
    setMessage(undefined)
    // An ended or closing camera is held no longer; tapping it starts afresh
    // under its name, as Record video would.
    const held =
      stream.state !== 'ended' && stream.closesAt == null
        ? stream.id
        : undefined
    request(stream.label, held).then(setOpen, (error: unknown) => {
      setMessage(error instanceof Error ? error.message : lstrings.common_retry)
    })
  }

  const upload = (recording: PhoneRecording): void => {
    const id = recording.liveStreamId
    setCancelled(({ [id]: _, ...rest }) => rest)
    setProgress(current => ({
      ...current,
      [id]: {
        liveStreamId: id,
        state: 'exporting',
        fraction: 0,
        bytesSent: 0,
        bytesTotal: 0,
        step: null,
        videoId: null,
        message: null
      }
    }))
    phone
      .uploadRecording({
        liveStreamId: id,
        apiBase: client.baseUrl,
        token: client.token ?? '',
        title: recording.angleName
      })
      .then(
        () => {
          refresh()
          reload().catch(() => undefined)
        },
        (error: unknown) => {
          setProgress(current => ({
            ...current,
            [id]: {
              ...current[id],
              state: 'failed',
              message: error instanceof Error ? error.message : null
            }
          }))
          refresh()
        }
      )
  }

  const cancel = (recording: PhoneRecording): void => {
    const id = recording.liveStreamId
    setCancelled(current => ({ ...current, [id]: true }))
    phone.cancelUpload(id).then(refresh, refresh)
  }

  return (
    <View style={styles.section}>
      <SectionHeader title={lstrings.stream_cameras_title} />
      {angles.map(({ stream, mine }) => {
        const own = mine && myId != null && stream.deviceId === myId
        const state = angleState(stream)
        const detail = [stream.deviceModel, mine ? null : stream.ownerName]
          .filter(part => part != null && part !== '')
          .join(' · ')
        const take = recordings.find(one => one.liveStreamId === stream.id)
        const elsewhere =
          mine &&
          myId != null &&
          stream.deviceId !== myId &&
          stream.localRecording === 'recorded' &&
          stream.deviceModel != null
        return (
          <View key={stream.id} style={styles.angle}>
            <Pressable
              style={styles.angleBody}
              disabled={!own}
              accessibilityRole={own ? 'button' : undefined}
              testID={`angle-row-${stream.id}`}
              onPress={() => {
                if (take != null && uploading(take)) {
                  setMessage(
                    sprintf(lstrings.stream_error_uploading, stream.label)
                  )
                  return
                }
                reopen(stream)
              }}
            >
              <View style={styles.angleText}>
                <Text style={styles.angleName}>{stream.label}</Text>
                {detail !== '' && <Text style={styles.detail}>{detail}</Text>}
                {elsewhere && (
                  <Text style={styles.detail}>
                    {sprintf(
                      lstrings.stream_angle_not_uploaded,
                      stream.deviceModel ?? ''
                    )}
                  </Text>
                )}
              </View>
              <View
                style={[styles.chip, state === 'live' && styles.liveChip]}
                testID={`angle-state-${stream.id}`}
              >
                <Text
                  style={[
                    styles.chipText,
                    state === 'live' && styles.liveChipText
                  ]}
                >
                  {state === 'live'
                    ? lstrings.stream_angle_live
                    : state === 'ended'
                      ? lstrings.stream_angle_ended
                      : lstrings.stream_angle_idle}
                </Text>
              </View>
            </Pressable>
            {streamActionsFor(stream, mine).length > 0 && (
              <Pressable
                style={styles.more}
                accessibilityRole="button"
                accessibilityLabel={sprintf(
                  lstrings.stream_angle_more,
                  stream.label
                )}
                testID={`angle-more-${stream.id}`}
                onPress={() => {
                  setMessage(undefined)
                  setSheet({ stream, mine })
                }}
              >
                <Text style={styles.moreText}>…</Text>
              </Pressable>
            )}
          </View>
        )
      })}
      {takes.map(recording => (
        <RecordingUploadRow
          key={recording.liveStreamId}
          recording={recording}
          name={nameOf(recording)}
          state={uploadRowState(
            recording,
            progress[recording.liveStreamId],
            Object.hasOwn(cancelled, recording.liveStreamId)
          )}
          onUpload={() => {
            upload(recording)
          }}
          onCancel={() => {
            cancel(recording)
          }}
        />
      ))}
      {supported && (
        <Button
          label={lstrings.stream_record_video}
          icon="videocam"
          kind="secondary"
          testID="record-video"
          onPress={() => {
            setMessage(undefined)
            setPromptKey(key => key + 1)
            setPrompting(true)
          }}
        />
      )}
      {message != null && <Text style={styles.message}>{message}</Text>}
      <AngleNamePrompt
        key={promptKey}
        visible={prompting}
        onCancel={() => {
          setPrompting(false)
        }}
        onStart={start}
        onDismiss={() => {
          if (pending == null) return
          setOpen(pending)
          setPending(undefined)
        }}
      />
      {sheet != null && (
        <StreamActionSheet
          client={client}
          gameId={gameId}
          stream={sheet.stream}
          mine={sheet.mine}
          copy={copy}
          onClose={() => {
            setSheet(undefined)
          }}
          onChanged={() => {
            reload().catch(() => undefined)
          }}
          onMessage={setMessage}
        />
      )}
      {open != null ? (
        <Screen
          client={client}
          session={open.session}
          deviceId={open.id}
          deviceModel={deviceModel}
          phone={phone}
          onClose={() => {
            setOpen(undefined)
            reload().catch(() => undefined)
            refresh()
          }}
        />
      ) : null}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  section: {
    gap: theme.rem(theme.spaceMdRem)
  },
  angle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem)
  },
  angleBody: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(theme.spaceXsRem)
  },
  angleText: {
    flex: 1,
    gap: theme.rem(0.125)
  },
  angleName: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '700',
    color: theme.primaryTextColor
  },
  detail: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  chip: {
    paddingHorizontal: theme.rem(0.5),
    paddingVertical: theme.rem(0.125),
    borderRadius: theme.rem(0.75),
    backgroundColor: theme.inactiveBackgroundColor
  },
  liveChip: {
    backgroundColor: theme.liveColor
  },
  chipText: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    fontWeight: '600',
    color: theme.secondaryTextColor
  },
  liveChipText: {
    color: '#FFFFFF'
  },
  more: {
    minWidth: theme.rem(2.75),
    minHeight: theme.rem(2.75),
    alignItems: 'center',
    justifyContent: 'center'
  },
  moreText: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.25),
    fontWeight: '700',
    color: theme.primaryTextColor
  },
  message: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  }
}))
