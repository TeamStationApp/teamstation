import React, { useEffect, useRef, useState } from 'react'
import { Linking, Platform } from 'react-native'

import type {
  CameraSource,
  LiveStream,
  TeamStationClient
} from '../../common/api'
import { lstrings } from '../locales/strings'
import { type CameraLinks, launchCamera } from './cameraDeepLinks'
import { CameraSourceSheet } from './CameraSourceSheet'
import { phoneStream } from './phoneStream'
import { RevokeSheet } from './RevokeSheet'
import { type RtmpTarget, RtmpUrlSheet } from './RtmpUrlSheet'

const systemLinks: CameraLinks = {
  canOpenURL: async url => await Linking.canOpenURL(url),
  openURL: async url => {
    await Linking.openURL(url)
  },
  appInstalled: phoneStream.appInstalled,
  openInApp: phoneStream.openInApp
}
type Step = 'source' | 'rtmp' | 'revoke'

/** External setup after the hero's name prompt has finished dismissing. */
export function ExternalCameraSetup({
  client,
  gameId,
  name,
  onClose,
  links = systemLinks,
  launchLimitMs = 30_000
}: {
  client: TeamStationClient
  gameId: string
  name: string
  onClose: () => void
  links?: CameraLinks
  launchLimitMs?: number
}): React.ReactElement {
  const [step, setStep] = useState<Step | undefined>('source')
  const [next, setNext] = useState<Step>()
  const [target, setTarget] = useState<RtmpTarget>()
  const [revoking, setRevoking] = useState<LiveStream>()
  const [busy, setBusy] = useState<CameraSource>()
  const [error, setError] = useState<string>()
  const active = useRef<AbortController | undefined>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const visible = useRef<Step | undefined>('source')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      active.current?.abort()
      clearTimeout(timer.current)
    }
  }, [])
  const go = (to: Step): void => {
    visible.current = undefined
    if (Platform.OS === 'ios') {
      setStep(undefined)
      setNext(to)
    } else {
      visible.current = to
      setStep(to)
    }
  }
  const dismissed = (): void => {
    if (next == null) return
    visible.current = next
    setStep(next)
    setNext(undefined)
  }
  const close = (): void => {
    if (!mounted.current) return
    mounted.current = false
    active.current?.abort()
    clearTimeout(timer.current)
    onClose()
  }
  const rtmp = (value: RtmpTarget): void => {
    setTarget(value)
    go('rtmp')
  }
  const choose = (source: CameraSource): void => {
    if (visible.current !== 'source' || active.current != null) return
    if (source === 'rtmp') {
      rtmp({ name, source })
      return
    }
    const abort = new AbortController()
    active.current = abort
    setBusy(source)
    setError(undefined)
    const timeout = new Promise<never>((_resolve, reject) => {
      timer.current = setTimeout(() => {
        abort.abort()
        reject(new Error(lstrings.stream_source_too_slow))
      }, launchLimitMs)
    })
    Promise.race([
      launchCamera({
        client,
        gameId,
        name,
        source,
        links,
        os: Platform.OS,
        signal: abort.signal,
        onCreated: () => {}
      }),
      timeout
    ])
      .then(
        result => {
          if (!mounted.current || abort.signal.aborted) return
          if (result.kind === 'opened') close()
          else if (result.kind === 'sheet') rtmp(result.target)
        },
        (reason: unknown) => {
          if (mounted.current)
            setError(
              reason instanceof Error ? reason.message : lstrings.common_retry
            )
        }
      )
      .finally(() => {
        clearTimeout(timer.current)
        active.current = undefined
        if (mounted.current) setBusy(undefined)
      })
  }
  return (
    <>
      <CameraSourceSheet
        visible={step === 'source'}
        onChoose={choose}
        onClose={close}
        onDismiss={dismissed}
        error={error}
        busy={busy}
      />
      {target != null && (
        <RtmpUrlSheet
          visible={step === 'rtmp'}
          client={client}
          gameId={gameId}
          target={target}
          onClose={close}
          onDismiss={dismissed}
          onRevoke={stream => {
            setRevoking(stream)
            go('revoke')
          }}
        />
      )}
      {revoking != null && (
        <RevokeSheet
          visible={step === 'revoke'}
          client={client}
          gameId={gameId}
          stream={revoking}
          onCancel={() => {
            go('rtmp')
          }}
          onRevoked={close}
          onDismiss={dismissed}
        />
      )}
    </>
  )
}
