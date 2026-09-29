import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { asDictationReply } from '../../common/api'
import { keyterms, promptContext } from '../../common/scoring/actions'
import { nextDecision } from '../../common/scoring/rules'
import { applyAction } from '../../common/scoring/session'
import type {
  Dictation,
  DictationAsk,
  DictationSocket,
  Microphone,
  UseDictationOptions
} from './dictationTypes'
import { openMicrophone as browserMicrophone } from './microphone'
import type { ScoringSessionState } from './scoringTypes'

/**
 * Dictation on the scoring screen: the socket, the microphone, and what the
 * scorer is shown while they talk.
 *
 * Turning it on opens the microphone and one socket for the session, and
 * sends the key terms for the at-bat. Holding the button sends a `start`
 * carrying the game as it stands, then audio; releasing ends the utterance.
 * What comes back — actions — goes to `onActions`, which puts them through
 * the screen's reducer exactly as a tap would. Nothing here changes a game.
 */

/**
 * The game as the next sentence will find it. A decided play stays open for
 * correction until the next pitch or play is reported, which closes it, so a
 * sentence spoken now is about the next at-bat: its batter, its count, its
 * runners. Only a runner movement still corrects the play before.
 */
export function upcoming(session: ScoringSessionState): {
  state: ScoringSessionState
  closed?: string
} {
  if (nextDecision(session) !== 'close') return { state: session }
  const applied = applyAction(session, { type: 'gameFlow', kind: 'closePlay' })
  if (applied.problems.length > 0) return { state: session }
  const play = session.liveData.plays.currentPlay
  return {
    state: applied.state,
    closed: play == null ? 'the last play' : play.result.description
  }
}

/** What the LLM is told about the game with each sentence. */
export function dictationContext(session: ScoringSessionState): string {
  const { state, closed } = upcoming(session)
  const context = promptContext(state)
  return closed == null
    ? context
    : `The last play (${closed}) is decided and closes when the next pitch or play is reported. The game below is the at-bat after it.\n${context}`
}

const OPEN = 1
const FIRST_RETRY_MS = 1000
const LAST_RETRY_MS = 30000
/**
 * How long audio keeps going to the recogniser after a release: the frames
 * the audio thread had captured but the page had not yet sent, and the last
 * syllable of a scorer who lets go as the word ends.
 */
export const RELEASE_TAIL_MS = 250
/** How much audio is kept while nobody talks, and one frame of it. */
const PRE_ROLL_MS = 1000
const FRAME_MS = 100

export function useDictation(options: UseDictationOptions): Dictation {
  const [enabled, setEnabledState] = useState(false)
  const [connected, setConnected] = useState(false)
  const [holding, setHolding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [ask, setAsk] = useState<DictationAsk | null>(null)
  const socket = useRef<DictationSocket | null>(null)
  const utterance = useRef<string | null>(null)
  const holdingNow = useRef(false)
  // Released, with the tail of its audio still going out.
  const releasing = useRef(false)
  // The last moment of audio, for a press that is a hold only once it lasts.
  const recent = useRef<Array<{ at: number; pcm: ArrayBuffer }>>([])
  const sentTerms = useRef<string | null>(null)
  const counter = useRef(0)
  const latest = useRef(options)
  latest.current = options

  const send = (frame: object | ArrayBuffer): boolean => {
    const open = socket.current
    if (open?.readyState !== OPEN) return false
    open.send(frame instanceof ArrayBuffer ? frame : JSON.stringify(frame))
    return true
  }

  /** Sends the key terms for the game as it stands, unless they were the last sent. */
  const sendTerms = useCallback((): void => {
    const terms = keyterms(upcoming(latest.current.session).state)
    const key = JSON.stringify(terms)
    if (key === sentTerms.current) return
    if (send({ kind: 'keyterms', keyterms: terms })) sentTerms.current = key
  }, [])

  const settle = (shown: string | null): void => {
    utterance.current = null
    setBusy(false)
    setAsk(null)
    setMessage(shown)
  }

  const onReply = (data: unknown): void => {
    let reply
    try {
      reply = asDictationReply(JSON.parse(String(data)))
    } catch {
      return
    }
    if (reply.id == null || reply.id !== utterance.current) {
      if (reply.kind === 'error' && reply.id == null) setMessage(reply.message)
      return
    }
    switch (reply.kind) {
      case 'partial':
      case 'transcript':
        setText(reply.text)
        return
      case 'ask':
        setAsk({
          question: reply.question,
          options: reply.options.map(option => ({ label: option.label }))
        })
        return
      case 'actions':
        setText(reply.transcript)
        settle(
          reply.dropped.length > 0
            ? `Left out: ${reply.dropped.map(problem => problem.message).join('; ')}`
            : null
        )
        latest.current.onActions(reply.transcript, reply.actions)
        return
      case 'error':
        settle(reply.message)
    }
  }

  const replies = useRef(onReply)
  replies.current = onReply

  // The socket and the microphone, for as long as dictation is on.
  useEffect(() => {
    if (!enabled) return
    let live = true
    let delay = FIRST_RETRY_MS
    let timer: ReturnType<typeof setTimeout> | undefined
    let microphone: Microphone | null = null
    const open =
      latest.current.openSocket ??
      (url => new WebSocket(url) as unknown as DictationSocket)
    const connect = (): void => {
      const ws = open(options.url)
      ws.binaryType = 'arraybuffer'
      socket.current = ws
      ws.onopen = () => {
        delay = FIRST_RETRY_MS
        setConnected(true)
        // A new socket has been told nothing: its first frame is the terms.
        sentTerms.current = null
        sendTerms()
      }
      ws.onmessage = event => {
        replies.current(event.data)
      }
      ws.onerror = () => undefined
      ws.onclose = () => {
        if (socket.current === ws) socket.current = null
        setConnected(false)
        if (utterance.current != null) {
          holdingNow.current = false
          setHolding(false)
          settle(
            'The connection dropped and that was not scored. Say it again.'
          )
        }
        if (!live) return
        timer = setTimeout(connect, delay)
        delay = Math.min(delay * 2, LAST_RETRY_MS)
      }
    }
    connect()
    ;(latest.current.openMicrophone ?? browserMicrophone)(pcm => {
      if (holdingNow.current && utterance.current != null) {
        send(pcm)
        return
      }
      const now = Date.now()
      recent.current = [
        ...recent.current.filter(frame => now - frame.at < PRE_ROLL_MS),
        { at: now, pcm }
      ]
    }).then(
      opened => {
        if (live) microphone = opened
        else opened.stop()
      },
      (error: unknown) => {
        if (!live) return
        setMessage(
          `The microphone is not available: ${error instanceof Error ? error.message : String(error)}`
        )
        setEnabledState(false)
      }
    )
    return () => {
      live = false
      clearTimeout(timer)
      utterance.current = null
      holdingNow.current = false
      const ws = socket.current
      socket.current = null
      ws?.close()
      microphone?.stop()
      setConnected(false)
      setHolding(false)
      setBusy(false)
      setAsk(null)
    }
  }, [enabled, options.url, sendTerms])

  // A new at-bat, or a change of who is in the game, retargets the recogniser.
  // The next at-bat's, once the play before is decided.
  const next = useMemo(() => upcoming(options.session).state, [options.session])
  const atBatIndex = next.liveData.plays.currentPlay?.about.atBatIndex
  const lineupChanges = options.log.filter(
    action => action.type === 'lineup'
  ).length
  useEffect(() => {
    sendTerms()
  }, [atBatIndex, lineupChanges, sendTerms])

  return {
    enabled,
    connected,
    holding,
    busy,
    text,
    message,
    ask,
    setEnabled: on => {
      if (on) setMessage(null)
      setEnabledState(on)
    },
    hold: since => {
      if (utterance.current != null || socket.current?.readyState !== OPEN)
        return
      const id = `u${Date.now().toString(36)}${(counter.current++).toString(36)}`
      const { gameId, session, model } = latest.current
      utterance.current = id
      holdingNow.current = true
      setHolding(true)
      setText('')
      setMessage(null)
      setAsk(null)
      send({
        kind: 'start',
        id,
        scope: 'scoring',
        target: { gameId },
        context: dictationContext(session),
        ...(model == null ? {} : { model })
      })
      if (since != null)
        for (const frame of recent.current)
          if (frame.at >= since - FRAME_MS) send(frame.pcm)
      recent.current = []
    },
    release: () => {
      if (!holdingNow.current || releasing.current) return
      setHolding(false)
      const id = utterance.current
      if (id == null) {
        holdingNow.current = false
        return
      }
      setBusy(true)
      releasing.current = true
      const end = (): void => {
        releasing.current = false
        // Switched off, or dropped, in the meantime: nothing to end.
        if (utterance.current !== id) return
        holdingNow.current = false
        send({ kind: 'release', id })
      }
      const tail = latest.current.tailMs ?? RELEASE_TAIL_MS
      if (tail <= 0) end()
      else setTimeout(end, tail)
    },
    answer: option => {
      const id = utterance.current
      if (id == null || ask == null) return
      setAsk(null)
      send({ kind: 'answer', id, option })
    },
    dismiss: () => {
      const id = utterance.current
      if (id == null) return
      send({ kind: 'dismiss', id })
      settle(null)
    }
  }
}

/** The dictation socket's address, from the API's base URL. */
export function dictationUrl(
  apiBaseUrl: string,
  location: { protocol: string; host: string } = window.location
): string {
  const absolute = /^https?:\/\//.test(apiBaseUrl)
    ? apiBaseUrl
    : `${location.protocol}//${location.host}${apiBaseUrl.startsWith('/') ? '' : '/'}${apiBaseUrl}`
  return `${absolute.replace(/^http/, 'ws').replace(/\/+$/, '')}/dictation`
}
