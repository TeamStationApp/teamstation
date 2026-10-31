import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Linking, Platform, Text, View } from 'react-native'

import type {
  CameraSource,
  GameLiveStreams,
  LiveStream,
  StreamAccess,
  TeamStationClient
} from '../../common/api'
import { observeUpload } from '../../common/observability/upload'
import { SectionHeader } from '../components/SectionHeader'
import { phoneStreamActions } from '../components/streamActions'
import { lstrings, sprintf } from '../locales/strings'
import { usePublishingReport } from '../player/useVideoListRefresh'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { AngleNamePrompt } from './AngleNamePrompt'
import {
  type CameraLinks,
  launchCamera,
  type LinkedCamera
} from './cameraDeepLinks'
import { CameraRow } from './CameraRow'
import {
  type Angle,
  cameraRefusal,
  type CameraTap,
  isEnded,
  orderAngles
} from './cameraRowRules'
import { CameraSourceSheet } from './CameraSourceSheet'
import { ConfirmSheet } from './ConfirmSheet'
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
import { RevokeSheet } from './RevokeSheet'
import { type RtmpTarget, RtmpUrlSheet } from './RtmpUrlSheet'
import { StreamActionSheet } from './StreamActionSheet'
import { StreamEmptyState } from './StreamEmptyState'
import {
  StreamingScreen,
  type StreamingSession
} from './StreamingScreen.native'
import { StreamPill } from './StreamPill'
import { useLocalCopies } from './useLocalCopies'
import { VideoDetailsSheet } from './VideoDetailsSheet'

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
  /** Opens the camera apps; a test hands in its own. */
  links?: CameraLinks
  /** The videos this game's cameras are publishing to, each time that changes. */
  onPublishing?: (videoIds: string[]) => void
  /** Whether the game has a video to play. Without one the tab says so here. */
  hasVideo: boolean
  /** Plays one of the game's videos in the player above. */
  onPlay?: (videoId: string) => void
}

const systemLinks: CameraLinks = {
  canOpenURL: async url => await Linking.canOpenURL(url),
  openURL: async url => {
    await Linking.openURL(url)
  }
}

/** The sheet up, or the next once iOS has taken the last away. */
type SheetStep =
  | 'name'
  | 'source'
  | 'rtmp'
  | 'revoke'
  | 'details'
  | 'deleteVideo'
  | 'deleteCopy'
  | 'end'

interface OpenCamera {
  session: StreamingSession
  id: string
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
 * The phone's camera area on a game's Videos tab.
 *
 * - "No videos", while the game has no video and no camera (`StreamEmptyState`).
 * - A row for every camera on the game (`CameraRow`), the caller's first, then
 *   other people's: what it is doing, how long it has run, and what can be
 *   done with it. Ended cameras go at the bottom, below Record Video.
 * - A row for every take on this phone that TeamStation does not have yet,
 *   with Upload Recording.
 * - Record Video, which steps through setup: the angle's name, then this
 *   phone's camera or an external one: its make, then its own app or, for any
 *   other camera, its RTMP URL. Disabled with the reason beside it at either
 *   limit on cameras.
 *
 * It asks `streamAccess` first, and only somebody who may film reads the
 * cameras: anybody else is answered `404` for them.
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
    copy,
    links = systemLinks,
    hasVideo,
    onPlay
  } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  /** Undefined until it answers; null when it could not. */
  const [access, setAccess] = useState<StreamAccess | null | undefined>(
    undefined
  )
  const [streams, setStreams] = useState<GameLiveStreams | undefined>(undefined)
  const [myId, setMyId] = useState<string | undefined>(undefined)
  const [capabilities, setCapabilities] = useState<
    PhoneStreamCapabilities | undefined
  >(undefined)
  const takesOnPhone = useRecordingsOf(phone)
  const { recordings, refresh } = takesOnPhone
  /** Each upload's latest word, from the engine or from the press itself. */
  const [progress, setProgress] = useState<Record<string, UploadProgress>>({})
  /** Takes whose upload was cancelled here, back to their button. */
  const [cancelled, setCancelled] = useState<Record<string, true>>({})
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [sheet, setSheet] = useState<Angle | undefined>(undefined)
  const [step, setStep] = useState<SheetStep | undefined>(undefined)
  /** The step that waits for iOS to finish taking the last sheet away. */
  const [nextStep, setNextStep] = useState<SheetStep | undefined>(undefined)
  /** Bumped each time the prompt opens, so it opens empty. */
  const [promptKey, setPromptKey] = useState(0)
  /** The angle's name, carried from the prompt to the camera's make. */
  const [angleName, setAngleName] = useState('')
  /** Why the camera's row went nowhere, shown on the sheet that is still up. */
  const [sourceError, setSourceError] = useState<string | undefined>(undefined)
  const [rtmp, setRtmp] = useState<RtmpTarget | undefined>(undefined)
  /** Bumped each time the RTMP sheet opens, so it asks afresh. */
  const [rtmpKey, setRtmpKey] = useState(0)
  const [revoking, setRevoking] = useState<LiveStream | undefined>(undefined)
  /** The camera Video details, delete or End is about. */
  const [chosen, setChosen] = useState<LiveStream | undefined>(undefined)
  /** Where a delete's Cancel goes back to. */
  const [fromDetails, setFromDetails] = useState(false)
  /** The camera to open once the prompt has gone. */
  const [pending, setPending] = useState<OpenCamera | undefined>(undefined)
  const [open, setOpen] = useState<OpenCamera | undefined>(undefined)
  const live = useRef(true)
  /** A row's camera is being made, so a second tap must not make another. */
  const launching = useRef(false)
  const askDeviceId = useRef(deviceId)
  askDeviceId.current = deviceId

  usePublishingReport(streams, props.onPublishing)

  const reload = useCallback(async (): Promise<void> => {
    const next = await client.liveStreams(gameId)
    if (live.current) setStreams(next)
  }, [client, gameId])
  const reloadQuietly = useCallback((): void => {
    reload().catch(() => undefined)
  }, [reload])
  const { dropCopy } = useLocalCopies({
    client,
    gameId,
    phone,
    streams,
    myId,
    takes: takesOnPhone,
    reload: reloadQuietly
  })

  useEffect(() => {
    live.current = true
    client.streamAccess(gameId).then(
      found => {
        if (!live.current) return
        setAccess(found)
        if (found.canFilm) reloadQuietly()
      },
      () => {
        if (live.current) setAccess(null)
      }
    )
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
  }, [client, gameId, phone, reloadQuietly])

  // Every five seconds while the panel is up: the cameras, and this phone's
  // takes, so a camera another phone starts appears and a finished upload's
  // row goes.
  const canFilm = access?.canFilm === true
  useEffect(() => {
    if (!canFilm) return
    const timer = setInterval(() => {
      reloadQuietly()
      refresh()
    }, ANGLES_POLL_MS)
    return () => {
      clearInterval(timer)
    }
  }, [canFilm, refresh, reloadQuietly])

  useEffect(
    () =>
      phone.onUpload(next => {
        setProgress(current => ({ ...current, [next.liveStreamId]: next }))
        if (next.state === 'uploaded') reloadQuietly()
      }),
    [phone, reloadQuietly]
  )

  // iOS presents one modal at a time: the camera waits for the prompt to
  // finish leaving (`onDismiss`). Elsewhere it opens at once.
  useEffect(() => {
    if (step === 'name' || pending == null || Platform.OS === 'ios') return
    setOpen(pending)
    setPending(undefined)
  }, [pending, step])

  const { active, ended } = orderAngles(streams)
  const angles = [...active, ...ended]
  const takes = recordings.filter(
    recording =>
      recording.gameId === gameId &&
      recording.uploadedAt == null &&
      recording.liveStreamId !== open?.session.streamId &&
      streams?.discarded.includes(recording.liveStreamId) !== true
  )
  const supported = capabilities?.supported === true
  if (access === undefined || (canFilm && streams == null)) return null
  const empty = !hasVideo && (!canFilm || angles.length + takes.length === 0)
  if (!empty && !canFilm) return null

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
    const { canRecordLocally } = await phone.capabilities()
    const stream = await client.addLiveStream(gameId, name, {
      deviceId: id,
      deviceModel,
      recordsLocally: canRecordLocally,
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

  /** The next sheet, or none. iOS waits for this one to leave (`sheetGone`). */
  const goTo = (next: SheetStep | undefined): void => {
    if (Platform.OS === 'ios' && step != null) {
      setStep(undefined)
      setNextStep(next)
    } else setStep(next)
  }

  const sheetGone = (): void => {
    if (nextStep != null) {
      setStep(nextStep)
      setNextStep(undefined)
    }
    if (pending == null) return
    setOpen(pending)
    setPending(undefined)
  }

  const record = (): void => {
    setMessage(undefined)
    setPromptKey(key => key + 1)
    goTo('name')
  }

  const start = async (name: string): Promise<void> => {
    setPending(await request(name))
    goTo(undefined)
  }

  const openRtmp = (target: RtmpTarget): void => {
    setRtmp(target)
    setRtmpKey(key => key + 1)
    goTo('rtmp')
  }

  const launch = (source: LinkedCamera): void => {
    if (launching.current) return
    launching.current = true
    setSourceError(undefined)
    launchCamera({
      client,
      gameId,
      name: angleName,
      source,
      links,
      os: Platform.OS,
      onCreated: reloadQuietly
    })
      .then(
        launched => {
          if (launched.kind === 'opened') goTo(undefined)
          if (launched.kind === 'sheet') openRtmp(launched.target)
        },
        (error: unknown) => {
          setSourceError(
            error instanceof Error ? error.message : lstrings.common_retry
          )
        }
      )
      .finally(() => {
        launching.current = false
      })
  }

  const chooseSource = (source: CameraSource): void => {
    if (source === 'rtmp') openRtmp({ name: angleName, source })
    else launch(source)
  }

  const reopen = (stream: LiveStream): void => {
    setMessage(undefined)
    const take = recordings.find(one => one.liveStreamId === stream.id)
    if (take != null && uploading(take)) {
      setMessage(sprintf(lstrings.stream_error_uploading, stream.label))
      return
    }
    request(stream.label, stream.id).then(setOpen, (error: unknown) => {
      setMessage(error instanceof Error ? error.message : lstrings.common_retry)
    })
  }

  /** Opens one of the sheets about a camera. */
  const choose = (stream: LiveStream, next: SheetStep): void => {
    setMessage(undefined)
    setChosen(stream)
    setFromDetails(step === 'details')
    goTo(next)
  }

  const tapRow = (tap: CameraTap, stream: LiveStream): void => {
    switch (tap) {
      case 'details':
        choose(stream, 'details')
        break
      case 'play':
        if (stream.playableVideoId != null) onPlay?.(stream.playableVideoId)
        break
      case 'rtmp':
        openRtmp({ stream })
        break
      case 'camera':
        reopen(stream)
        break
      case 'none':
        break
    }
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
    observeUpload(
      async () =>
        await phone.uploadRecording({
          liveStreamId: id,
          apiBase: client.baseUrl,
          token: client.token ?? '',
          title: recording.angleName
        }),
      client.captureAnalytics,
      recording.hasPendingUpload
    ).then(
      () => {
        refresh()
        reloadQuietly()
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

  const limit =
    streams?.gameCanAdd === 0
      ? lstrings.stream_limit_game
      : streams?.canAdd === 0
        ? sprintf(lstrings.stream_limit_person, streams.maxCameras)
        : undefined
  /** A camera as the list last gave it, or as it was when it was chosen. */
  const asListed = (stream: LiveStream | undefined): LiveStream | undefined =>
    angles.find(angle => angle.stream.id === stream?.id)?.stream ?? stream
  /** The camera to revoke; the list says whether it went live. */
  const revokeTarget = asListed(revoking)
  const chosenStream = asListed(chosen)
  const chosenTake = recordings.find(
    recording => recording.liveStreamId === chosen?.id
  )
  const row = ({ stream, mine }: Angle): React.ReactElement => {
    const elsewhere = myId != null && stream.deviceId !== myId
    return (
      <CameraRow
        key={stream.id}
        stream={stream}
        mine={mine}
        myId={myId}
        note={
          cameraRefusal(stream, mine) ??
          (mine &&
          elsewhere &&
          stream.localRecording === 'recorded' &&
          stream.deviceModel != null
            ? sprintf(lstrings.stream_angle_not_uploaded, stream.deviceModel)
            : undefined)
        }
        onTap={tap => {
          tapRow(tap, stream)
        }}
        onEnd={
          mine && elsewhere && stream.deviceId != null && !isEnded(stream)
            ? () => {
                choose(stream, 'end')
              }
            : undefined
        }
        onDelete={
          mine && isEnded(stream)
            ? () => {
                choose(stream, 'deleteVideo')
              }
            : undefined
        }
        onMore={
          phoneStreamActions(stream, mine).length > 0
            ? () => {
                setMessage(undefined)
                setSheet({ stream, mine })
              }
            : undefined
        }
      />
    )
  }

  return (
    <View style={styles.section}>
      {empty ? (
        <StreamEmptyState client={client} access={access} onRecord={record} />
      ) : (
        <>
          <SectionHeader title={lstrings.stream_cameras_title} />
          {active.map(row)}
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
          <StreamPill
            label={lstrings.stream_record_video}
            disabled={limit != null}
            testID="record-video"
            onPress={record}
          />
          {limit != null && (
            <Text style={styles.limit} testID="record-video-limit">
              {limit}
            </Text>
          )}
          {ended.map(row)}
        </>
      )}
      {message != null && <Text style={styles.message}>{message}</Text>}
      <AngleNamePrompt
        key={promptKey}
        visible={step === 'name'}
        canRecord={supported}
        onCancel={() => {
          goTo(undefined)
        }}
        onStart={start}
        onExternal={name => {
          setAngleName(name)
          setSourceError(undefined)
          goTo('source')
        }}
        onDismiss={sheetGone}
      />
      <CameraSourceSheet
        visible={step === 'source'}
        onChoose={chooseSource}
        onClose={() => {
          goTo(undefined)
        }}
        onDismiss={sheetGone}
        error={sourceError}
      />
      {rtmp != null && (
        <RtmpUrlSheet
          key={`rtmp-${rtmpKey}`}
          visible={step === 'rtmp'}
          client={client}
          gameId={gameId}
          target={rtmp}
          copy={copy}
          onClose={() => {
            goTo(undefined)
            reloadQuietly()
          }}
          onCreated={reloadQuietly}
          onRevoke={stream => {
            setRevoking(stream)
            goTo('revoke')
          }}
          onDismiss={sheetGone}
        />
      )}
      {revoking != null && revokeTarget != null && (
        <RevokeSheet
          visible={step === 'revoke'}
          client={client}
          gameId={gameId}
          stream={revokeTarget}
          onCancel={() => {
            openRtmp({ stream: revoking })
          }}
          onRevoked={() => {
            goTo(undefined)
            reloadQuietly()
          }}
          onDismiss={sheetGone}
        />
      )}
      {chosenStream != null && (
        <>
          <VideoDetailsSheet
            visible={step === 'details'}
            stream={chosenStream}
            take={chosenTake}
            uploading={chosenTake != null && uploading(chosenTake)}
            onPlay={videoId => {
              goTo(undefined)
              onPlay?.(videoId)
            }}
            onDeleteVideo={() => {
              choose(chosenStream, 'deleteVideo')
            }}
            onUpload={take => {
              goTo(undefined)
              upload(take)
            }}
            onDeleteCopy={() => {
              choose(chosenStream, 'deleteCopy')
            }}
            onClose={() => {
              goTo(undefined)
            }}
            onDismiss={sheetGone}
          />
          <ConfirmSheet
            visible={step === 'deleteVideo'}
            title={lstrings.stream_delete_title}
            body={lstrings.stream_delete_body}
            angle={chosenStream.label}
            confirmLabel={lstrings.stream_details_delete}
            id="delete-video"
            onConfirm={async () => {
              const next = await client.discardLiveStream(
                gameId,
                chosenStream.id
              )
              if (live.current) setStreams(next)
            }}
            onDone={() => {
              goTo(undefined)
            }}
            onCancel={() => {
              goTo(fromDetails ? 'details' : undefined)
            }}
            onDismiss={sheetGone}
          />
          <ConfirmSheet
            visible={step === 'deleteCopy'}
            title={lstrings.stream_delete_copy_title}
            body={lstrings.stream_delete_copy_body}
            angle={chosenStream.label}
            confirmLabel={lstrings.stream_details_delete_copy}
            id="delete-copy"
            onConfirm={async () => {
              await dropCopy(chosenStream)
            }}
            onDone={() => {
              goTo('details')
            }}
            onCancel={() => {
              goTo('details')
            }}
            onDismiss={sheetGone}
          />
          <ConfirmSheet
            visible={step === 'end'}
            title={lstrings.stream_end_title}
            body={lstrings.stream_end_body}
            angle={chosenStream.label}
            confirmLabel={lstrings.stream_row_end}
            id="end-camera"
            onConfirm={async () => {
              await client.endLiveStream(gameId, chosenStream.id)
            }}
            onDone={() => {
              goTo(undefined)
              reloadQuietly()
            }}
            onCancel={() => {
              goTo(undefined)
            }}
            onDismiss={sheetGone}
          />
        </>
      )}
      {sheet != null && (
        <StreamActionSheet
          client={client}
          gameId={gameId}
          stream={sheet.stream}
          mine={sheet.mine}
          elsewhere={sheet.stream.deviceId !== myId}
          onClose={() => {
            setSheet(undefined)
          }}
          onChanged={reloadQuietly}
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
            reloadQuietly()
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
  limit: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor,
    textAlign: 'center'
  },
  message: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  }
}))
