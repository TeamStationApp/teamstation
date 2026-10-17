import React, { useEffect, useRef, useState } from 'react'
import { Platform } from 'react-native'

import type { LiveStream, TeamStationClient } from '../../common/api'
import { lstrings, sprintf } from '../locales/strings'
import { AngleNamePrompt } from './AngleNamePrompt'
import { deviceId as installId } from './deviceId'
import type { GameRecording } from './gameRecording'
import { type PhoneStream, phoneStream } from './phoneStream'
import {
  StreamingScreen,
  type StreamingSession
} from './StreamingScreen.native'

interface Camera {
  attempt: number
  session: StreamingSession
  deviceId: string
  deviceModel: string
}

/** The hero's Record action uses the camera permissions, never DJ permissions. */
export function useGameRecording(
  client: TeamStationClient,
  gameId: string,
  phone: PhoneStream = phoneStream,
  deviceId: () => Promise<string> = installId,
  Screen = StreamingScreen
): GameRecording {
  const [available, setAvailable] = useState<{
    client: TeamStationClient
    gameId: string
  }>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [prompt, setPrompt] = useState<number>()
  const [promptKey, setPromptKey] = useState(0)
  const [pending, setPending] = useState<Camera>()
  const [camera, setCamera] = useState<Camera>()
  const generation = useRef(0)
  const working = useRef(false)
  const scope = useRef({ client, gameId })
  scope.current = { client, gameId }
  const current = (id: number): boolean =>
    id === generation.current &&
    scope.current.client === client &&
    scope.current.gameId === gameId

  useEffect(() => {
    let live = true
    setAvailable(undefined)
    setPrompt(undefined)
    setPending(undefined)
    setCamera(undefined)
    setError(undefined)
    setBusy(false)
    working.current = false
    // Unsupported devices never ask for the protected cameras collection.
    phone
      .capabilities()
      .then(async capabilities => {
        if (!live || !capabilities.supported) return
        await client.liveStreams(gameId)
        if (live) setAvailable({ client, gameId })
      })
      .catch(() => {})
    return () => {
      live = false
      generation.current += 1
    }
  }, [client, gameId, phone])

  const cancel = (): void => {
    generation.current += 1
    working.current = false
    setBusy(false)
    setPrompt(undefined)
    setPending(undefined)
    setCamera(undefined)
  }

  const request = async (
    attempt: number,
    name: string,
    held?: LiveStream
  ): Promise<Camera> => {
    const [id, capabilities, recordings] = await Promise.all([
      deviceId(),
      phone.capabilities(),
      phone.recordings()
    ])
    if (!current(attempt)) throw new Error(lstrings.common_retry)
    if (!capabilities.supported) throw new Error(lstrings.common_retry)
    if (
      recordings.some(
        take =>
          take.gameId === gameId &&
          (take.liveStreamId === held?.id ||
            take.angleName.toLowerCase() === name.toLowerCase()) &&
          take.uploadedAt == null &&
          (take.hasPendingUpload || take.uploadRunning)
      )
    )
      throw new Error(sprintf(lstrings.stream_error_uploading, name))
    const stream = await client.addLiveStream(gameId, name, {
      deviceId: id,
      deviceModel: capabilities.deviceModel,
      recordsLocally: true,
      ...(held == null ? {} : { heldStreamId: held.id })
    })
    if (!current(attempt)) throw new Error(lstrings.common_retry)
    const url =
      stream.url ?? (await client.revealLiveStream(gameId, stream.id)).url
    if (url == null) throw new Error(lstrings.common_retry)
    return {
      attempt,
      deviceId: id,
      deviceModel: capabilities.deviceModel,
      session: {
        gameId,
        streamId: stream.id,
        url,
        angleName: stream.label,
        localRecording: stream.localRecording
      }
    }
  }

  const open = (): void => {
    if (working.current || camera != null || prompt != null) return
    working.current = true
    const attempt = ++generation.current
    setBusy(true)
    setError(undefined)
    ;(async () => {
      const [streams, id, interrupted, recordings] = await Promise.all([
        client.liveStreams(gameId),
        deviceId(),
        phone.interruptedSession(),
        phone.recordings()
      ])
      if (!current(attempt)) return
      const own = streams.mine.filter(
        stream =>
          stream.deviceId === id &&
          stream.state !== 'ended' &&
          stream.closesAt == null
      )
      const recent = recordings
        .filter(take => take.gameId === gameId && take.uploadedAt == null)
        .sort((a, b) => b.startedAt - a.startedAt)
      const preferred = [
        ...(interrupted?.gameId === gameId ? [interrupted.liveStreamId] : []),
        ...recent.map(take => take.liveStreamId)
      ]
      const held =
        preferred
          .map(streamId => own.find(stream => stream.id === streamId))
          .find(stream => stream != null) ?? own[0]
      if (held == null) {
        setPromptKey(attempt)
        setPrompt(attempt)
      } else {
        const next = await request(attempt, held.label, held)
        if (current(attempt)) setCamera(next)
      }
    })()
      .catch((reason: unknown) => {
        if (current(attempt))
          setError(
            reason instanceof Error ? reason.message : lstrings.common_retry
          )
      })
      .finally(() => {
        if (current(attempt)) {
          working.current = false
          setBusy(false)
        }
      })
  }

  const start = async (name: string): Promise<void> => {
    if (prompt == null) return
    const attempt = prompt
    const next = await request(attempt, name)
    if (!current(attempt)) return
    setPrompt(undefined)
    // iOS must dismiss the name modal before presenting the camera modal.
    if (Platform.OS === 'ios') setPending(next)
    else setCamera(next)
  }

  return {
    open:
      available?.client === client && available.gameId === gameId
        ? open
        : undefined,
    busy,
    error,
    screen: (
      <>
        <AngleNamePrompt
          key={promptKey}
          visible={prompt != null}
          onCancel={cancel}
          onStart={start}
          onDismiss={() => {
            if (pending == null || !current(pending.attempt)) return
            setCamera(pending)
            setPending(undefined)
          }}
        />
        {camera != null && current(camera.attempt) && (
          <Screen
            client={client}
            session={camera.session}
            deviceId={camera.deviceId}
            deviceModel={camera.deviceModel}
            phone={phone}
            startOnOpen
            onClose={cancel}
          />
        )}
      </>
    )
  }
}
