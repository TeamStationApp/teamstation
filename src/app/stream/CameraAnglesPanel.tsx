import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import {
  type CameraSource,
  canDeleteCameraVideo,
  type GameLiveStreams,
  type LiveStream,
  type StreamAccess
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { Button } from '../components/Button'
import { useSceneShown } from '../components/sceneShown'
import { SectionHeader } from '../components/SectionHeader'
import { phoneStreamActions } from '../components/streamActions'
import { lstrings, sprintf } from '../locales/strings'
import { usePublishingReport } from '../player/useVideoListRefresh'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { AngleNamePrompt } from './AngleNamePrompt'
import { launchWebCamera } from './cameraDeepLinks'
import { CameraRow } from './CameraRow'
import {
  type Angle,
  cameraLimit,
  cameraRefusal,
  isEnded,
  orderAngles
} from './cameraRowRules'
import { CameraSourceSheet } from './CameraSourceSheet'
import { ConfirmSheet } from './ConfirmSheet'
import { RevokeSheet } from './RevokeSheet'
import { type RtmpTarget, RtmpUrlSheet } from './RtmpUrlSheet'
import { StreamActionSheet } from './StreamActionSheet'
import { StreamEmptyState } from './StreamEmptyState'
import type { StreamFooterProps } from './streamFooterProps'
import { StreamPill } from './StreamPill'
import { VideoDetailsSheet } from './VideoDetailsSheet'

type Sheet =
  | { kind: 'name' }
  | { kind: 'source'; name: string }
  | { kind: 'rtmp'; target: RtmpTarget }
  | { kind: 'revoke' | 'details' | 'more' | 'end'; id: string }
  | { kind: 'delete'; id: string; fromDetails: boolean }

/** How long a read of the cameras may go unanswered before a poll asks again. */
export const STALE_POLL_MS = 20_000

/** Web shares the camera rows and sheets with native. Every device camera is remote. */
export function CameraAnglesPanel({
  client,
  gameId,
  hasVideo,
  signedIn,
  onPlay,
  onPublishing
}: StreamFooterProps): React.ReactElement | null {
  const styles = getStyles(useTheme())
  const shown = useSceneShown()
  const [access, setAccess] = useState<StreamAccess | null>()
  const [streams, setStreams] = useState<GameLiveStreams>()
  const [sheet, setSheet] = useState<Sheet>()
  const [busy, setBusy] = useState<CameraSource>()
  const [error, setError] = useState<string>()
  const launch = useRef<AbortController | undefined>(undefined)
  const revision = useRef(0)
  const watchChanges = useRef(true)
  const mounted = useRef(false)

  // A newer read, a covered scene, or a changed session invalidates older answers.
  const refresh = useCallback(async () => {
    if (!mounted.current) return
    const reading = ++revision.current
    try {
      const next = await client.streamAccess(gameId)
      if (revision.current !== reading) return
      watchChanges.current = next.canFilm || next.canRequest || next.requested
      setAccess(next)
      if (!next.canFilm) {
        setStreams(undefined)
        setSheet(undefined)
        launch.current?.abort()
        return
      }
      const cameras = await client.liveStreams(gameId)
      if (revision.current === reading && cameras.gameId === gameId)
        setStreams(cameras)
    } catch (caught) {
      if (revision.current !== reading) return
      if (
        caught instanceof HttpError &&
        (caught.code === 'notFound' ||
          caught.status === 401 ||
          caught.status === 403)
      ) {
        watchChanges.current = false
        setAccess(null)
        setStreams(undefined)
        setSheet(undefined)
        launch.current?.abort()
      } else setAccess(old => (old === undefined ? null : old))
    }
  }, [client, gameId])
  useEffect(() => {
    if (!shown || signedIn !== true) return
    mounted.current = true
    /** When the read under way began, or null with none under way. */
    let pollingSince: number | null = null
    const poll = (): void => {
      if (document.hidden) return
      // One read at a time, but not one that never answers: a request the
      // server never finished held every later poll back, and the panel said
      // a camera publishing again was idle until the page was reloaded. A
      // newer read makes the older one's answer count for nothing.
      const now = Date.now()
      if (pollingSince != null && now - pollingSince < STALE_POLL_MS) return
      pollingSince = now
      const started = now
      refresh()
        .finally(() => {
          if (pollingSince === started) pollingSince = null
        })
        .catch(() => undefined)
    }
    poll()
    const timer = setInterval(() => {
      if (watchChanges.current) poll()
    }, 5000)
    const visible = (): void => {
      if (!document.hidden) refresh().catch(() => undefined)
    }
    document.addEventListener('visibilitychange', visible)
    return () => {
      mounted.current = false
      revision.current++
      clearInterval(timer)
      document.removeEventListener('visibilitychange', visible)
      launch.current?.abort()
    }
  }, [shown, signedIn, refresh])

  usePublishingReport(streams, onPublishing)
  const close = (): void => {
    setSheet(undefined)
    setError(undefined)
  }
  const changed = (): void => {
    // A dismissed confirmation can finish after another sheet has opened.
    setSheet(current => (current === sheet ? undefined : current))
    refresh().catch(() => undefined)
  }
  const chooseSource = (source: CameraSource): void => {
    if (sheet?.kind !== 'source' || launch.current != null) return
    const name = sheet.name
    if (source === 'rtmp') {
      setSheet({ kind: 'rtmp', target: { name, source } })
      return
    }
    const controller = new AbortController()
    launch.current = controller
    setBusy(source)
    setError(undefined)
    const timer = setTimeout(() => {
      if (controller.signal.aborted) return
      controller.abort()
      setError(lstrings.stream_source_too_slow)
    }, 30000)
    controller.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        if (launch.current === controller) {
          launch.current = undefined
          setBusy(undefined)
        }
      },
      { once: true }
    )
    launchWebCamera(
      {
        client,
        gameId,
        name,
        source,
        onCreated: () => {
          if (!controller.signal.aborted) refresh().catch(() => undefined)
        },
        signal: controller.signal
      },
      link => {
        window.location.assign(link)
      }
    )
      .then(
        result => {
          if (controller.signal.aborted) return
          if (result.kind === 'sheet')
            setSheet({ kind: 'rtmp', target: result.target })
          else close()
        },
        (caught: unknown) => {
          if (!controller.signal.aborted)
            setError(
              caught instanceof Error ? caught.message : lstrings.common_retry
            )
        }
      )
      .finally(() => {
        clearTimeout(timer)
        if (launch.current === controller) {
          launch.current = undefined
          setBusy(undefined)
        }
      })
  }

  const { active, ended } = orderAngles(streams)
  const chosen =
    sheet != null && 'id' in sheet
      ? [...active, ...ended].find(angle => angle.stream.id === sheet.id)
      : undefined
  const stream = chosen?.stream
  const limit = cameraLimit(streams)
  const record = (): void => {
    setError(undefined)
    setSheet({ kind: 'name' })
  }
  const rtmp = (camera: LiveStream): void => {
    setSheet({ kind: 'rtmp', target: { stream: camera } })
  }
  const row = ({ stream: camera, mine }: Angle): React.ReactElement => {
    const id = camera.id
    const remotePhone = mine && camera.deviceId != null
    return (
      <View key={id}>
        <CameraRow
          stream={camera}
          mine={mine}
          myId={undefined}
          note={
            cameraRefusal(camera, mine) ??
            (remotePhone &&
            camera.localRecording === 'recorded' &&
            camera.deviceModel != null
              ? sprintf(lstrings.stream_angle_not_uploaded, camera.deviceModel)
              : undefined)
          }
          onTap={tap => {
            if (tap === 'rtmp') rtmp(camera)
            if (tap === 'details') setSheet({ kind: 'details', id })
            if (tap === 'play' && camera.playableVideoId != null)
              onPlay?.(camera.playableVideoId)
          }}
          onEnd={
            remotePhone && !isEnded(camera)
              ? () => {
                  setSheet({ kind: 'end', id })
                }
              : undefined
          }
          onMore={
            phoneStreamActions(camera, mine).length > 0
              ? () => {
                  setSheet({ kind: 'more', id })
                }
              : undefined
          }
          onDelete={
            mine && canDeleteCameraVideo(camera)
              ? () => {
                  setSheet({ kind: 'delete', id, fromDetails: false })
                }
              : undefined
          }
        />
        {remotePhone && !isEnded(camera) && (
          <Button
            kind="text"
            compact
            label={lstrings.stream_show_url}
            onPress={() => {
              rtmp(camera)
            }}
          />
        )}
        {mine && camera.status != null && (
          <details
            style={{
              color: styles.detail.color,
              fontFamily: styles.detail.fontFamily,
              fontSize: styles.detail.fontSize,
              padding: '0.25rem 0.5rem'
            }}
          >
            <summary>{lstrings.stream_status_details}</summary>
            <Text style={styles.detail}>
              {camera.status.ingress.receivingPackets
                ? `Receiving ${((camera.status.ingress.bytesPerSecond * 8) / 1e6).toFixed(1)} Mbit/s`
                : camera.status.ingress.publishing
                  ? 'Connected, but no video is arriving'
                  : 'Nothing is streaming to this yet'}
            </Text>
            {camera.status.outputs.map(output => (
              <Text key={output.label} style={styles.detail}>
                {output.kind === 'hls' ? 'TeamStation' : 'Relay'} ·{' '}
                {output.state}
                {output.recordedSec != null
                  ? ` · ${Math.floor(output.recordedSec)} s`
                  : ''}
                {output.restartCount > 0
                  ? ` · reconnected ${output.restartCount}×`
                  : ''}
                {output.lastError != null ? ` · ${output.lastError}` : ''}
              </Text>
            ))}
          </details>
        )}
        {mine &&
          camera.lastError != null &&
          cameraRefusal(camera, mine) == null && (
            <Text style={styles.detail}>{camera.lastError}</Text>
          )}
      </View>
    )
  }

  if (signedIn === null) return null
  if (
    signedIn &&
    (access === undefined || (access?.canFilm === true && streams == null))
  )
    return null
  const empty = !hasVideo && active.length + ended.length === 0
  if (!empty && access?.canFilm !== true) return null
  return (
    <View style={styles.section}>
      {empty ? (
        <StreamEmptyState
          client={client}
          access={access ?? null}
          filmingHint={lstrings.stream_empty_external}
          onRecord={record}
          onRequested={() => {
            revision.current++
            setAccess(old => (old == null ? old : { ...old, requested: true }))
          }}
        />
      ) : (
        <>
          <SectionHeader title={lstrings.stream_cameras_title} />
          {active.map(row)}
          <StreamPill
            label={lstrings.stream_record_video}
            testID="record-video"
            disabled={limit != null}
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
      {sheet?.kind === 'name' && (
        <AngleNamePrompt
          visible
          canRecord={false}
          onCancel={close}
          onExternal={name => {
            setSheet({ kind: 'source', name })
          }}
        />
      )}
      {sheet?.kind === 'source' && (
        <CameraSourceSheet
          visible
          onClose={close}
          onChoose={chooseSource}
          busy={busy}
          error={error}
        />
      )}
      {sheet?.kind === 'rtmp' && (
        <RtmpUrlSheet
          visible
          client={client}
          gameId={gameId}
          target={sheet.target}
          onClose={changed}
          onCreated={() => {
            refresh().catch(() => undefined)
          }}
          onRevoke={camera => {
            setSheet({ kind: 'revoke', id: camera.id })
            refresh().catch(() => undefined)
          }}
        />
      )}
      {stream != null && (
        <>
          {sheet?.kind === 'more' && (
            <StreamActionSheet
              client={client}
              gameId={gameId}
              stream={stream}
              mine={chosen?.mine === true}
              elsewhere
              onClose={close}
              onChanged={() => {
                refresh().catch(() => undefined)
              }}
            />
          )}
          {sheet?.kind === 'details' && (
            <VideoDetailsSheet
              visible
              stream={stream}
              onPlay={id => {
                close()
                onPlay?.(id)
              }}
              onDeleteVideo={() => {
                setSheet({ kind: 'delete', id: stream.id, fromDetails: true })
              }}
              onClose={close}
            />
          )}
          {sheet?.kind === 'revoke' && (
            <RevokeSheet
              visible
              stream={stream}
              client={client}
              gameId={gameId}
              onCancel={() => {
                rtmp(stream)
              }}
              onRevoked={changed}
            />
          )}
          {sheet?.kind === 'end' && (
            <ConfirmSheet
              visible
              title={lstrings.stream_end_title}
              body={lstrings.stream_end_body}
              angle={stream.label}
              confirmLabel={lstrings.stream_row_end}
              id="end-camera"
              onConfirm={async () => {
                await client.endLiveStream(gameId, stream.id)
              }}
              onCancel={close}
              onDone={changed}
            />
          )}
          {sheet?.kind === 'delete' && (
            <ConfirmSheet
              visible
              title={lstrings.stream_delete_title}
              body={lstrings.stream_delete_body}
              angle={stream.label}
              confirmLabel={lstrings.stream_details_delete}
              id="delete-video"
              onConfirm={async () => {
                await client.discardLiveStream(gameId, stream.id)
              }}
              onCancel={() => {
                sheet.fromDetails
                  ? setSheet({ kind: 'details', id: stream.id })
                  : close()
              }}
              onDone={changed}
            />
          )}
        </>
      )}
    </View>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  section: { gap: theme.rem(theme.spaceMdRem) },
  detail: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  limit: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor,
    textAlign: 'center'
  }
}))
