import { type RefObject, useCallback, useEffect, useRef, useState } from 'react'

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

export interface TessChatState {
  /** The conversation is still being read. */
  loading: boolean
  messages: TessMessage[]
  /**
   * Tess is answering: a message or a confirmed change is with the server,
   * and until it is answered nothing else is sent or confirmed.
   */
  thinking: boolean
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
 * turn running) is taken back and the composer gets its draft again. Any
 * other failure, the answer lost on the way included, has the conversation
 * read again once Tess is done: the message is found by the id it was sent
 * with, and shown with whatever she did; one the server did not keep is
 * taken back and its draft given back. Once it is answered, the changes
 * shown before it are expired, as the server has just made them, so none
 * offers a hold that can only be refused.
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
      const takeBack = (): void => {
        setMessages(current =>
          current.filter(message => message.id !== optimistic.id)
        )
      }
      setMessages(current => [...current, optimistic])
      setError(null)
      try {
        const answer = await api.sendTessMessage(text, {
          ...(attachments.length > 0
            ? { attachmentIds: attachments.map(attachment => attachment.id) }
            : {}),
          ...(screen.current?.() != null ? { screen: screen.current() } : {}),
          clientId
        })
        if (mounted.current)
          setMessages(current =>
            merged(
              pendingExpired(
                current.filter(message => message.id !== optimistic.id)
              ),
              answer
            )
          )
        return true
      } catch (failure) {
        if (!mounted.current) return false
        if (
          failure instanceof HttpError &&
          REFUSED_UNSTORED.includes(failure.code)
        ) {
          setError(messageOf(failure))
          takeBack()
          return false
        }
        const conversation = await settledConversation(api, mounted)
        if (!mounted.current) return false
        if (conversation == null) {
          setError(messageOf(failure))
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
        end()
      }
    },
    [api]
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
      try {
        const answer = await api.confirmTessChange(changeId)
        if (mounted.current)
          setMessages(current =>
            merged(
              withChange(current, changeId, () => answer.change),
              answer.messages
            )
          )
      } catch (failure) {
        if (!mounted.current) return
        setError(messageOf(failure))
        // The server knows whether it ran: show what it says once Tess is
        // done, or let the user hold again when it cannot be asked either.
        const conversation = await settledConversation(api, mounted)
        if (!mounted.current) return
        if (conversation != null) setMessages(conversation.messages)
        else setStatus(changeId, 'pending')
      } finally {
        end()
      }
    },
    [api]
  )

  const showError = useCallback((message: string) => {
    setError(message)
  }, [])

  return {
    loading,
    messages,
    thinking: inFlight > 0,
    error,
    send,
    upload,
    confirm,
    showError
  }
}
