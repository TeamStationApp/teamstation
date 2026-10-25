import React, { useCallback, useMemo, useRef } from 'react'

import type { TeamStationClient } from '../../common/api'
import { useDictationControls } from '../scoring/DictationButton'
import type { DictationControlsProps } from '../scoring/dictationTypes'
import { dictationUrl } from '../scoring/useDictation'
import type { ComposerHandle } from './Composer'
import { TessChat } from './TessChat'
import type { TessApi, TessScreen } from './tessTypes'
import { useTess } from './useTess'

/** How long Space is held before Tess listens. */
export const SPACE_HOLD_MS = 500

export interface TessPanelProps {
  client: TessApi & Pick<TeamStationClient, 'baseUrl' | 'token' | 'health'>
  onClose: () => void
  /** An app path from a link or a way bubble in the chat. */
  onNavigate: (path: string) => void
  /** What the right pane shows, sent with each message on a wide screen. */
  screen?: () => TessScreen | undefined
  /** The microphone's socket, audio and timings, replaced in tests. */
  dictation?: Pick<
    DictationControlsProps,
    'openSocket' | 'openMicrophone' | 'tapMs' | 'tailMs'
  >
}

/**
 * Tess's chat as the app shows it: the conversation read from the server,
 * and the microphone under the field. Mounted only while the chat is shown,
 * so opening it turns dictation on and closing it lets the microphone go.
 *
 * The microphone is scoring's push-to-talk with no game: the `tess` scope
 * ends at the transcript, which goes into the composer and is sent from
 * there with the draft's files, or waits in the field while Tess is still
 * answering. Space held half a second talks, wherever the focus is, while
 * the microphone is on; a shorter press is the page's, since on a wide
 * screen the app beside the chat needs it.
 */
export function TessPanel({
  client,
  onClose,
  onNavigate,
  screen,
  dictation: replaced
}: TessPanelProps): React.ReactElement {
  const tess = useTess(client, { screen })
  const composer = useRef<ComposerHandle>(null)
  const health = useCallback(async () => await client.health(), [client])
  const url = useMemo(() => dictationUrl(client.baseUrl), [client])
  const dictation = useDictationControls({
    scope: 'tess',
    target: {},
    contextOf: () => 'tess',
    onTranscript: text => {
      composer.current?.dictate(text)
    },
    startEnabled: true,
    spaceTalks: true,
    spaceHoldMs: SPACE_HOLD_MS,
    shape: 'round',
    health,
    url,
    token: client.token,
    ...replaced
  })
  return (
    <TessChat
      tess={tess}
      onClose={onClose}
      onNavigate={onNavigate}
      mic={dictation.control}
      composer={composer}
    />
  )
}
