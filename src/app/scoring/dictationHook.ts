import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { asDictationReply } from '../../common/api'
import { keyterms, promptContext } from '../../common/scoring/actions'
import { rosterPrompt } from '../../common/scoring/rosterCommands'
import { upcoming } from '../../common/scoring/session'
import { lstrings, sprintf } from '../locales/strings'
import { openDictationSocket } from './dictationSocket'
import type {
  Dictation,
  DictationAsk,
  DictationSocket,
  Microphone,
  UseDictationOptions
} from './dictationTypes'
import { openMicrophone as browserMicrophone } from './microphone'
import type { ScoringSessionState, Side } from './scoringTypes'

/** The game as the next sentence will find it. */
export { upcoming }

/**
 * Dictation on the scoring and roster screens, and in Tess's chat: the
 * socket, the microphone, and what the speaker is shown while they talk.
 *
 * Turning it on opens the microphone and one socket for the session, and
 * sends the key terms for the at-bat. Holding the button sends a `start`
 * naming the scope and its target and carrying the game as it stands, then
 * audio; releasing ends the utterance. What comes back — actions and roster
 * commands — goes to `onActions`: the scoring screen puts actions through its
 * reducer exactly as a tap would, and the roster screen stages commands on
 * its draft. Tess has no game: her scope ends at the transcript, which goes
 * to `onTranscript` and becomes the next chat message. Nothing here changes a
 * game.
 */

/** A coach's side, when the screen's target names one. */
function coachSide(
  target: Record<string, unknown> | undefined
): Side | undefined {
  const side = target?.side
  return side === 'away' || side === 'home' ? side : undefined
}

/**
 * What the LLM is told about the game with each sentence: the at-bat, then
 * both teams' rosters, bench and all, so a substitution can name anyone.
 */
export function dictationContext(session: ScoringSessionState): string {
  const { state, closed } = upcoming(session)
  const context = `${promptContext(state)}\nROSTERS\n${rosterPrompt(state, ['away', 'home'])}`
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
  const releaseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  )
  // Each time dictation is switched on. An open that finishes for an older
  // generation must not stop the recorder a newer open already owns.
  const openGeneration = useRef(0)
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
    const { session, target } = latest.current
    // Without a game there is nobody to listen out for.
    if (session == null) return
    const terms = keyterms(upcoming(session).state, coachSide(target))
    const key = JSON.stringify(terms)
    if (key === sentTerms.current) return
    if (send({ kind: 'keyterms', keyterms: terms })) sentTerms.current = key
  }, [])

  const settle = (shown: string | null): void => {
    utterance.current = null
    // The tail may still be waiting. A new sentence has to be able to end;
    // the tail's own timer sees this id is gone and does not clear that one.
    releasing.current = false
    setBusy(false)
    setAsk(null)
    setMessage(shown)
  }

  const onReply = (data: unknown): void => {
    let reply
    try {
      reply = asDictationReply(JSON.parse(String(data)))
    } catch {
      // A frame that is not a reply would otherwise leave the utterance open,
      // and the button would refuse another sentence until dictation is toggled.
      if (utterance.current == null) return
      holdingNow.current = false
      releasing.current = false
      clearTimeout(releaseTimer.current)
      releaseTimer.current = undefined
      setHolding(false)
      settle(lstrings.dictation_dropped)
      return
    }
    if (reply.id == null || reply.id !== utterance.current) {
      if (reply.kind === 'error' && reply.id == null) setMessage(reply.message)
      return
    }
    switch (reply.kind) {
      case 'partial':
        setText(reply.text)
        return
      case 'transcript': {
        setText(reply.text)
        const { onTranscript } = latest.current
        // Words that were heard are the answer. Blank ones wait for the
        // server's error, which says nothing was heard.
        if (onTranscript == null || reply.text.trim() === '') return
        settle(null)
        onTranscript(reply.text)
        return
      }
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
            ? sprintf(
                lstrings.dictation_left_out,
                reply.dropped.map(problem => problem.message).join('; ')
              )
            : null
        )
        latest.current.onActions?.(
          reply.transcript,
          reply.actions,
          reply.roster ?? [],
          reply.undo
        )
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
      (url => openDictationSocket(url, latest.current.token))
    const connect = (): void => {
      const ws = open(options.url)
      ws.binaryType = 'arraybuffer'
      socket.current = ws
      ws.onopen = () => {
        // A socket replaced, or dictation switched off, before this one opened.
        if (!live || socket.current !== ws) return
        delay = FIRST_RETRY_MS
        setConnected(true)
        // A new socket has been told nothing: its first frame is the terms.
        sentTerms.current = null
        sendTerms()
      }
      ws.onmessage = event => {
        if (!live || socket.current !== ws) return
        replies.current(event.data)
      }
      ws.onerror = () => undefined
      ws.onclose = () => {
        // Cleanup closes the socket after clearing `socket.current`, and a
        // reconnect replaces it before the old one finishes closing. Either
        // way this close is not the socket the button is using.
        if (!live || socket.current !== ws) return
        socket.current = null
        setConnected(false)
        if (utterance.current != null) {
          holdingNow.current = false
          setHolding(false)
          settle(lstrings.dictation_dropped)
        }
        timer = setTimeout(connect, delay)
        delay = Math.min(delay * 2, LAST_RETRY_MS)
      }
    }
    connect()
    const generation = ++openGeneration.current
    ;(latest.current.openMicrophone ?? browserMicrophone)(
      pcm => {
        // An open that lost the race, or one that finished after dictation
        // went off, must not feed the utterance that replaced it.
        if (!live || generation !== openGeneration.current) return
        if (holdingNow.current && utterance.current != null) {
          send(pcm)
          return
        }
        const now = Date.now()
        recent.current = [
          ...recent.current.filter(frame => now - frame.at < PRE_ROLL_MS),
          { at: now, pcm }
        ]
      },
      message => {
        if (!live || generation !== openGeneration.current) return
        setMessage(sprintf(lstrings.dictation_mic_unavailable, message))
        setEnabledState(false)
      }
    ).then(
      opened => {
        // A newer open has its own listener. This one drops its listener.
        // The phone recorder stops only when that was the last listener.
        if (generation !== openGeneration.current || !live) {
          opened.stop()
          return
        }
        microphone = opened
      },
      (error: unknown) => {
        if (!live || generation !== openGeneration.current) return
        setMessage(
          sprintf(
            lstrings.dictation_mic_unavailable,
            error instanceof Error ? error.message : String(error)
          )
        )
        setEnabledState(false)
      }
    )
    return () => {
      live = false
      clearTimeout(timer)
      clearTimeout(releaseTimer.current)
      releaseTimer.current = undefined
      releasing.current = false
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
  const next = useMemo(
    () =>
      options.session == null ? undefined : upcoming(options.session).state,
    [options.session]
  )
  const atBatIndex = next?.liveData.plays.currentPlay?.about.atBatIndex
  const lineupChanges = (options.log ?? []).filter(
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
      const {
        gameId,
        session,
        model,
        scope = 'scoring',
        target = { gameId },
        contextOf
      } = latest.current
      const context =
        contextOf?.() ?? (session == null ? null : dictationContext(session))
      if (context == null) return
      const id = `u${Date.now().toString(36)}${(counter.current++).toString(36)}`
      utterance.current = id
      holdingNow.current = true
      setHolding(true)
      setText('')
      setMessage(null)
      setAsk(null)
      send({
        kind: 'start',
        id,
        scope,
        target,
        context,
        // Player tags name a game's players; without one there are none.
        ...(session == null ? {} : { tagOrder: [...session.meta.tagOrder] }),
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
        releaseTimer.current = undefined
        // Switched off, or a newer sentence, in the meantime. Leave
        // `releasing` as that sentence set it.
        if (utterance.current !== id) return
        releasing.current = false
        holdingNow.current = false
        send({ kind: 'release', id })
      }
      const tail = latest.current.tailMs ?? RELEASE_TAIL_MS
      if (tail <= 0) end()
      else releaseTimer.current = setTimeout(end, tail)
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
