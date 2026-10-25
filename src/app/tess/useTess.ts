import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'

import { TessTurnError } from '../../common/api'
import { type ErrorCode, HttpError } from '../../common/errors'
import { lstrings } from '../locales/strings'
import type {
  TessApi,
  TessAttachmentRef,
  TessChange,
  TessChangeStatus,
  TessConversation,
  TessMessage,
  TessScreen,
  TessStep,
  TessStreamEvent,
  TessUpload
} from './tessTypes'

/** How long the chat waits between reads while Tess is still answering. */
export const ANSWERING_POLL_MS = 2000

/**
 * What the server answers a message with before it stores any of it: a
 * malformed or refused message, too large a one, or a turn already running.
 */
const REFUSED_UNSTORED: readonly ErrorCode[] = [
  'badRequest',
  'unauthorized',
  'forbidden',
  'conflict',
  'tooLarge',
  'unsupportedMedia'
]

/** A reply on its way: what Tess has told of it so far. */
export interface TessLive {
  /** The summary of her thinking, as it grows. */
  thinking: string
  /** Her steps, by the tool call each is, in the order they started. */
  steps: Array<TessStep & { id: string }>
  /** Her text, as it grows. */
  text: string
}

export interface TessChatState {
  /** The conversation is still being read. */
  loading: boolean
  messages: TessMessage[]
  /**
   * Tess is answering: a message or a confirmed change is with the server,
   * and until it is answered nothing else is sent or confirmed.
   */
  thinking: boolean
  /** The reply Tess is working on, while she answers in this chat. */
  live: TessLive | null
  /**
   * How long Tess thought, in whole seconds, for each reply she gave while
   * the chat was open, by its id: from the message to her last thought or
   * step. A reply read from history has none.
   */
  thoughtSeconds: Readonly<Record<string, number>>
  /** What went wrong last, shown under the composer. */
  error: string | null
  /** Answers whether the message reached Tess; false while she is answering. */
  send: (text: string, attachments: TessAttachmentRef[]) => Promise<boolean>
  upload: (upload: TessUpload) => Promise<TessAttachmentRef | null>
  confirm: (changeId: string) => Promise<void>
  showError: (message: string) => void
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message !== ''
    ? error.message
    : lstrings.tess_error
}

/** A fresh id for a message the app sends, to find it by later. */
function newClientId(): string {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
}

/**
 * The conversation as the server has it once no turn holds it: `first`, or a
 * read, and another every `ANSWERING_POLL_MS` while Tess is still answering.
 * A request that gave up waiting for a long turn (a phone's network stack
 * does, after a minute) leaves her answering on the server. Null when the
 * conversation cannot be read, or the chat has closed.
 */
async function settledConversation(
  api: TessApi,
  mounted: RefObject<boolean>,
  first?: TessConversation
): Promise<TessConversation | null> {
  let conversation = first
  for (;;) {
    if (conversation != null) {
      if (conversation.answering !== true) return conversation
      await new Promise<void>(resolve => {
        setTimeout(() => {
          resolve()
        }, ANSWERING_POLL_MS)
      })
      if (!mounted.current) return null
    }
    try {
      conversation = await api.tess()
    } catch {
      return null
    }
    if (!mounted.current) return null
  }
}

/** Messages the server answered, over the ones already shown. */
function merged(shown: TessMessage[], answered: TessMessage[]): TessMessage[] {
  const byId = new Map(answered.map(message => [message.id, message]))
  const kept = shown.map(message => byId.get(message.id) ?? message)
  const known = new Set(shown.map(message => message.id))
  return [...kept, ...answered.filter(message => !known.has(message.id))]
}

/**
 * The messages with every change still waiting to be confirmed shown as
 * expired: the server expires them when the person says something new.
 */
function pendingExpired(messages: TessMessage[]): TessMessage[] {
  return messages.map(message =>
    message.changes.some(change => change.status === 'pending')
      ? {
          ...message,
          changes: message.changes.map(change =>
            change.status === 'pending'
              ? { ...change, status: 'expired' as const }
              : change
          )
        }
      : message
  )
}

/** The changes `ids` pending again, where they show as expired. */
function pendingAgain(
  messages: TessMessage[],
  ids: ReadonlySet<string>
): TessMessage[] {
  return messages.map(message =>
    message.changes.some(
      change => change.status === 'expired' && ids.has(change.id)
    )
      ? {
          ...message,
          changes: message.changes.map(change =>
            change.status === 'expired' && ids.has(change.id)
              ? { ...change, status: 'pending' as const }
              : change
          )
        }
      : message
  )
}

function withChange(
  messages: TessMessage[],
  changeId: string,
  update: (change: TessChange) => TessChange
): TessMessage[] {
  return messages.map(message =>
    message.changes.some(change => change.id === changeId)
      ? {
          ...message,
          changes: message.changes.map(change =>
            change.id === changeId ? update(change) : change
          )
        }
      : message
  )
}

/**
 * The chat's state: the user's one conversation with Tess, read when the
 * chat opens, and read until she is done when she is still answering. A sent
 * message shows at once, with a thinking row under it until Tess answers.
 * One the server refused before storing it (malformed, too large, or another
 * turn running) is taken back and the composer gets its draft again, as is
 * one the stream's failure says the server took back (Tess failed before
 * storing anything of her answer): the changes it showed as expired are
 * pending again, as the server has made them. Any
 * other failure, the answer lost on the way included, has the conversation
 * read again once Tess is done: the message is found by the id it was sent
 * with, and shown with whatever she did; one the server did not keep is
 * taken back and its draft given back. Once it is answered, the changes
 * shown before it are expired, as the server has just made them, so none
 * offers a hold that can only be refused.
 *
 * A message and a confirm are streamed: while Tess works, `live` holds her
 * thinking, her steps and her text as they arrive, redrawn at most once a
 * frame, and her stored reply takes its place when she is done. Once the
 * server has stored the message it replaces the one shown, and a confirmed
 * change shows how it ended before her report on it.
 */
export function useTess(
  api: TessApi,
  options: { screen?: () => TessScreen | undefined } = {}
): TessChatState {
  const [loading, setLoading] = useState(true)
  const [messages, setMessages] = useState<TessMessage[]>([])
  const [inFlight, setInFlight] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  // Messages and confirms with the server, counted: the server takes one
  // turn at a time, so nothing more is sent while any is out.
  const working = useRef(0)
  const pendingId = useRef(0)
  const screen = useRef(options.screen)
  screen.current = options.screen

  const begin = (): void => {
    working.current += 1
    setInFlight(count => count + 1)
  }
  const end = (): void => {
    working.current -= 1
    if (mounted.current) setInFlight(count => count - 1)
  }

  const { live, thoughtSeconds, tell, stopTelling } = useLiveReply(mounted)

  useEffect(() => {
    mounted.current = true
    api.tess().then(
      conversation => {
        if (!mounted.current) return
        setMessages(current => merged(conversation.messages, current))
        setLoading(false)
        if (conversation.answering !== true) return
        // Opened while she answers: her answer shows when she is done.
        begin()
        settledConversation(api, mounted, conversation).then(settled => {
          if (settled != null && mounted.current) setMessages(settled.messages)
          end()
        }, end)
      },
      (failure: unknown) => {
        if (!mounted.current) return
        setError(messageOf(failure))
        setLoading(false)
      }
    )
    return () => {
      mounted.current = false
    }
  }, [api])

  const send = useCallback(
    async (text: string, attachments: TessAttachmentRef[]) => {
      if (working.current > 0) return false
      begin()
      const clientId = newClientId()
      const optimistic: TessMessage = {
        id: `pending-${++pendingId.current}`,
        role: 'user',
        text,
        attachments,
        changes: [],
        createdAt: new Date().toISOString(),
        clientId
      }
      // The changes shown as expired once the server stored the message.
      let expired = new Set<string>()
      // Gone: shown as sent, or as stored, and its expired changes pending.
      const takeBack = (): void => {
        setMessages(current =>
          pendingAgain(
            current.filter(
              message =>
                message.id !== optimistic.id && message.clientId !== clientId
            ),
            expired
          )
        )
      }
      setMessages(current => [...current, optimistic])
      setError(null)
      let answer: TessMessage[] | undefined
      // The server told it stored the message: it is never given back.
      let stored = false
      try {
        answer = await api.streamTessMessage(
          text,
          {
            ...(attachments.length > 0
              ? { attachmentIds: attachments.map(attachment => attachment.id) }
              : {}),
            ...(screen.current?.() != null ? { screen: screen.current() } : {}),
            clientId
          },
          tell(event => {
            stored = true
            // Shown as the server has it, and the changes before it expired.
            setMessages(current => {
              expired = new Set(
                current.flatMap(message =>
                  message.changes.flatMap(change =>
                    change.status === 'pending' ? [change.id] : []
                  )
                )
              )
              return merged(
                pendingExpired(
                  current.filter(message => message.id !== optimistic.id)
                ),
                event.messages
              )
            })
          })
        )
        const replied = answer
        if (mounted.current)
          setMessages(current =>
            merged(
              pendingExpired(
                current.filter(message => message.id !== optimistic.id)
              ),
              replied
            )
          )
        return true
      } catch (failure) {
        stopTelling()
        if (!mounted.current) return false
        // The server says whether it has the message; a lost stream cannot.
        const told = failure instanceof TessTurnError ? failure.kept : null
        if (
          told === false ||
          (!stored &&
            failure instanceof HttpError &&
            REFUSED_UNSTORED.includes(failure.code))
        ) {
          setError(messageOf(failure))
          takeBack()
          return false
        }
        const conversation = await settledConversation(api, mounted)
        if (!mounted.current) return false
        if (conversation == null) {
          setError(messageOf(failure))
          // Kept, it stays as the server showed it, and is not sent twice.
          if (stored || told === true) return true
          takeBack()
          return false
        }
        setMessages(conversation.messages)
        const at = conversation.messages.findIndex(
          message => message.clientId === clientId
        )
        // Only the answer was lost on the way, and Tess has answered.
        const answered =
          at >= 0 &&
          (!(failure instanceof HttpError) || failure.code === 'offline') &&
          conversation.messages
            .slice(at + 1)
            .some(message => message.role === 'assistant')
        if (!answered) setError(messageOf(failure))
        // Kept: it reached Tess, and is not given back to send twice.
        return at >= 0
      } finally {
        if (answer != null) stopTelling(answer)
        end()
      }
    },
    [api, tell, stopTelling]
  )

  const upload = useCallback(
    async (file: TessUpload) => {
      setError(null)
      try {
        const stored = await api.uploadTessAttachment(file)
        return { ...stored, described: false }
      } catch (failure) {
        if (mounted.current) setError(messageOf(failure))
        return null
      }
    },
    [api]
  )

  const setStatus = (changeId: string, status: TessChangeStatus): void => {
    setMessages(current =>
      withChange(current, changeId, change => ({ ...change, status }))
    )
  }

  const confirm = useCallback(
    async (changeId: string) => {
      if (working.current > 0) return
      begin()
      setStatus(changeId, 'running')
      setError(null)
      let answered: TessMessage[] | undefined
      // How the change ended, as the server told it before she reports it.
      let told = false
      try {
        const answer = await api.streamTessConfirm(
          changeId,
          tell(stored => {
            const { change } = stored
            if (change == null) return
            told = true
            setMessages(current => withChange(current, changeId, () => change))
          })
        )
        answered = answer.messages
        if (mounted.current)
          setMessages(current =>
            merged(
              withChange(current, changeId, () => answer.change),
              answer.messages
            )
          )
      } catch (failure) {
        stopTelling()
        if (!mounted.current) return
        setError(messageOf(failure))
        // The server knows whether it ran: show what it says once Tess is
        // done, or what it already told, or let the user hold again when it
        // can be asked neither.
        const conversation = await settledConversation(api, mounted)
        if (!mounted.current) return
        if (conversation != null) setMessages(conversation.messages)
        else if (!told) setStatus(changeId, 'pending')
      } finally {
        if (answered != null) stopTelling(answered)
        end()
      }
    },
    [api, tell, stopTelling]
  )

  const showError = useCallback((message: string) => {
    setError(message)
  }, [])

  return {
    loading,
    messages,
    thinking: inFlight > 0,
    live,
    thoughtSeconds,
    error,
    send,
    upload,
    confirm,
    showError
  }
}

/** What a reply on its way has told so far, and when. */
interface Telling {
  live: TessLive
  startedAt: number
  /** When she last thought or took a step. */
  workedAt?: number
}

/**
 * The reply on its way: `tell` starts one and answers what takes its
 * events, drawn into `live` at most once a frame; `stopTelling` ends it,
 * keeping how long she thought on the reply she answered with.
 */
function useLiveReply(mounted: RefObject<boolean>): {
  live: TessLive | null
  thoughtSeconds: Record<string, number>
  tell: (
    onStored: (event: Extract<TessStreamEvent, { type: 'stored' }>) => void
  ) => (event: TessStreamEvent) => void
  stopTelling: (answered?: TessMessage[]) => void
} {
  const [live, setLive] = useState<TessLive | null>(null)
  const [thoughtSeconds, setThoughtSeconds] = useState<Record<string, number>>(
    {}
  )
  const telling = useRef<Telling | null>(null)
  const frame = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (frame.current != null) cancelAnimationFrame(frame.current)
      frame.current = null
    },
    []
  )

  const draw = useCallback((): void => {
    frame.current = null
    const current = telling.current
    if (current != null && mounted.current)
      setLive({ ...current.live, steps: [...current.live.steps] })
  }, [mounted])

  const tell = useCallback(
    (
      onStored: (event: Extract<TessStreamEvent, { type: 'stored' }>) => void
    ): ((event: TessStreamEvent) => void) => {
      const current: Telling = {
        live: { thinking: '', steps: [], text: '' },
        startedAt: Date.now()
      }
      telling.current = current
      return event => {
        if (telling.current !== current || !mounted.current) return
        if (event.type === 'stored') {
          onStored(event)
          return
        }
        if (event.type === 'text') current.live.text += event.delta
        else {
          current.workedAt = Date.now()
          if (event.type === 'thinking') current.live.thinking += event.delta
          else {
            const step = {
              id: event.id,
              label: event.label,
              status: event.status
            }
            const at = current.live.steps.findIndex(one => one.id === event.id)
            if (at < 0) current.live.steps.push(step)
            else current.live.steps[at] = step
          }
        }
        frame.current ??= requestAnimationFrame(draw)
      }
    },
    [mounted, draw]
  )

  const stopTelling = useCallback(
    (answered?: TessMessage[]): void => {
      const current = telling.current
      telling.current = null
      if (frame.current != null) cancelAnimationFrame(frame.current)
      frame.current = null
      if (!mounted.current) return
      setLive(null)
      const reply = answered?.find(message => message.role === 'assistant')
      if (reply == null || current?.workedAt == null) return
      const seconds = Math.max(
        1,
        Math.round((current.workedAt - current.startedAt) / 1000)
      )
      setThoughtSeconds(known => ({ ...known, [reply.id]: seconds }))
    },
    [mounted]
  )

  return { live, thoughtSeconds, tell, stopTelling }
}
