import React, { useEffect, useState } from 'react'
import { Platform, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { Button } from '../components/Button'
import { SectionHeader } from '../components/SectionHeader'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { AngleNamePrompt } from './AngleNamePrompt'
import { deviceId as installId } from './deviceId'
import {
  type PhoneStream,
  phoneStream,
  type PhoneStreamCapabilities
} from './phoneStream'
import {
  StreamingScreen,
  type StreamingSession
} from './StreamingScreen.native'

export interface CameraAnglesPanelProps {
  client: TeamStationClient
  gameId: string
  /** The engine; a test hands in one over a stand-in module. */
  phone?: PhoneStream
  /** This install's id; a test hands in its own. */
  deviceId?: () => Promise<string>
  /** The streaming screen, which a test may replace. */
  Screen?: typeof StreamingScreen
}

/**
 * The phone's "Cameras" on a game's Videos tab: Record video, which asks for
 * a camera angle's name, gets this phone's stream for it from the server and
 * opens the camera.
 *
 * Only the people who may film the game see it: anybody else is answered
 * `404` for the game's cameras and sees nothing, as with the web's panel. A
 * phone that cannot record (no HEVC encoder, or a build without the engine)
 * shows nothing either.
 */
export function CameraAnglesPanel(
  props: CameraAnglesPanelProps
): React.ReactElement | null {
  const {
    client,
    gameId,
    phone = phoneStream,
    deviceId = installId,
    Screen = StreamingScreen
  } = props
  const styles = getStyles(useTheme())
  const [allowed, setAllowed] = useState(false)
  const [capabilities, setCapabilities] = useState<
    PhoneStreamCapabilities | undefined
  >(undefined)
  const [prompting, setPrompting] = useState(false)
  /** Bumped each time the prompt opens, so it opens empty. */
  const [promptKey, setPromptKey] = useState(0)
  /** The camera to open once the prompt has gone. */
  const [pending, setPending] = useState<
    { session: StreamingSession; id: string } | undefined
  >(undefined)
  const [open, setOpen] = useState<
    { session: StreamingSession; id: string } | undefined
  >(undefined)

  useEffect(() => {
    let live = true
    client.liveStreams(gameId).then(
      () => {
        if (live) setAllowed(true)
      },
      () => {
        if (live) setAllowed(false)
      }
    )
    phone.capabilities().then(
      found => {
        if (live) setCapabilities(found)
      },
      () => {}
    )
    return () => {
      live = false
    }
  }, [client, gameId, phone])

  // iOS presents one modal at a time: the camera waits for the prompt to
  // finish leaving (`onDismiss`). Elsewhere it opens at once.
  useEffect(() => {
    if (prompting || pending == null || Platform.OS === 'ios') return
    setOpen(pending)
    setPending(undefined)
  }, [pending, prompting])

  if (!allowed || capabilities?.supported !== true) return null

  const start = async (name: string): Promise<void> => {
    const id = await deviceId()
    const stream = await client.addLiveStream(gameId, name, {
      deviceId: id,
      deviceModel: capabilities.deviceModel,
      recordsLocally: true
    })
    const url =
      stream.url ?? (await client.revealLiveStream(gameId, stream.id)).url
    if (url == null) throw new Error(lstrings.common_retry)
    setPending({
      id,
      session: {
        gameId,
        streamId: stream.id,
        url,
        angleName: stream.label,
        localRecording: stream.localRecording
      }
    })
    setPrompting(false)
  }

  return (
    <View style={styles.section}>
      <SectionHeader title={lstrings.stream_cameras_title} />
      <Button
        label={lstrings.stream_record_video}
        icon="videocam"
        kind="secondary"
        testID="record-video"
        onPress={() => {
          setPromptKey(key => key + 1)
          setPrompting(true)
        }}
      />
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
      {open != null ? (
        <Screen
          client={client}
          session={open.session}
          deviceId={open.id}
          deviceModel={capabilities.deviceModel}
          phone={phone}
          onClose={() => {
            setOpen(undefined)
          }}
        />
      ) : null}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  section: {
    gap: theme.rem(theme.spaceMdRem)
  }
}))
