import React, { useCallback, useMemo, useRef } from 'react'

import type { TeamStationClient } from '../../common/api'
import { dictationUrl } from '../scoring/useDictation'
import type { ComposerHandle } from './Composer'
import { TessChat } from './TessChat'
import { TessMicButton } from './TessMicButton'
import type { TessApi, TessScreen } from './tessTypes'
import { useTess } from './useTess'
import {
  type TessMicrophoneOptions,
  useTessMicrophone
} from './useTessMicrophone'

export { SPACE_HOLD_MS } from './useTessMicrophone'

export interface TessPanelProps {
  client: TessApi & Pick<TeamStationClient, 'baseUrl' | 'token' | 'health'>
  onClose: () => void
  /** An app path from a link or a way bubble in the chat. */
  onNavigate: (path: string) => void
  /** Content beside Tess, sent with each message on a wide screen. */
  screen?: () => TessScreen | undefined
  /**
   * The microphone's socket, audio and timings, replaced in tests; `tapMs`
   * stands for `PUSH_TO_TALK_MS`.
   */
  dictation?: Pick<
    TessMicrophoneOptions,
    'openSocket' | 'openMicrophone' | 'tapMs' | 'tailMs'
  >
  /** Asked once on opening: whether her field should take the focus. */
  takesFocus?: () => boolean
  /**
   * The signed-in user: their queue outlives the panel, so what waits for
   * Tess when it closes is there when it opens again.
   */
  owner?: string
}

/**
 * Tess's chat as the app shows it: the conversation read from the server,
 * and the microphone right of Send. The microphone is closed until it is
 * pressed (`useTessMicrophone`): the `tess` scope ends at the transcript,
 * which goes into the field at the cursor and waits there to be sent, while
 * Tess is answering or not. Space held half a second records, wherever the
 * focus is; a shorter press is the page's, since on a wide screen the app
 * beside the chat needs it.
 */
export function TessPanel({
  client,
  onClose,
  onNavigate,
  screen,
  dictation: replaced,
  takesFocus,
  owner
}: TessPanelProps): React.ReactElement {
  const tess = useTess(client, { screen, owner })
  const composer = useRef<ComposerHandle>(null)
  const health = useCallback(async () => await client.health(), [client])
  const url = useMemo(() => dictationUrl(client.baseUrl), [client])
  const mic = useTessMicrophone({
    health,
    url,
    token: client.token,
    onTranscript: text => {
      composer.current?.insertDictation(text)
    },
    ...replaced
  })
  return (
    <TessChat
      tess={tess}
      onClose={onClose}
      onNavigate={onNavigate}
      mic={mic.available ? <TessMicButton mic={mic} /> : undefined}
      dictating={mic.state === 'recording' ? mic.levels : undefined}
      micMessage={mic.message}
      composer={composer}
      takesFocus={takesFocus}
    />
  )
}
