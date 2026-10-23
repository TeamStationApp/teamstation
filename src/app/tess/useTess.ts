import { useCallback, useEffect, useRef, useState } from 'react'

import { lstrings } from '../locales/strings'
import type {
  TessApi,
  TessAttachmentRef,
  TessChange,
  TessChangeStatus,
  TessMessage,
  TessScreen,
  TessUpload
} from './tessTypes'

export interface TessChatState {
  /** The conversation is still being read. */
  loading: boolean
  messages: TessMessage[]
  /** Tess is answering: a message or a confirmed change is with the server. */
  thinking: boolean
  /** What went wrong last, shown under the composer. */
  error: string | null
  /** Answers whether the message reached Tess. */
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

/** Messages the server answered, over the ones already shown. */
function merged(shown: TessMessage[], answered: TessMessage[]): TessMessage[] {
  const byId = new Map(answered.map(message => [message.id, message]))
  const kept = shown.map(message => byId.get(message.id) ?? message)
  const known = new Set(shown.map(message => message.id))
  return [...kept, ...answered.filter(message => !known.has(message.id))]
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
 * chat opens. A sent message shows at once, with a thinking row under it
 * until Tess answers; if it fails it is taken back and the composer gets
 * its draft again.
 */
export function useTess(
  api: TessApi,
  options: { screen?: () => TessScreen | undefined } = {}
): TessChatState {
  const [loading, setLoading] = useState(true)
  const [messages, setMessages] = useState<TessMessage[]>([])
  const [thinking, setThinking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  const sending = useRef(false)
  const pendingId = useRef(0)
  const screen = useRef(options.screen)
  screen.current = options.screen

  useEffect(() => {
    mounted.current = true
    api.tess().then(
      conversation => {
        if (!mounted.current) return
        setMessages(current => merged(conversation.messages, current))
        setLoading(false)
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
      if (sending.current) return false
      sending.current = true
      const optimistic: TessMessage = {
        id: `pending-${++pendingId.current}`,
        role: 'user',
        text,
        attachments,
        changes: [],
        createdAt: new Date().toISOString()
      }
      setMessages(current => [...current, optimistic])
      setThinking(true)
      setError(null)
      try {
        const answer = await api.sendTessMessage({
          text,
          ...(attachments.length > 0
            ? { attachmentIds: attachments.map(attachment => attachment.id) }
            : {}),
          ...(screen.current?.() != null ? { screen: screen.current() } : {})
        })
        if (mounted.current)
          setMessages(current =>
            merged(
              current.filter(message => message.id !== optimistic.id),
              answer.messages
            )
          )
        return true
      } catch (failure) {
        if (mounted.current) {
          setMessages(current =>
            current.filter(message => message.id !== optimistic.id)
          )
          setError(messageOf(failure))
        }
        return false
      } finally {
        sending.current = false
        if (mounted.current) setThinking(false)
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
      setStatus(changeId, 'running')
      setThinking(true)
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
        // The server knows whether it ran: show what it says, or let the
        // user hold again when it cannot be asked either.
        try {
          const conversation = await api.tess()
          if (mounted.current) setMessages(conversation.messages)
        } catch {
          if (mounted.current) setStatus(changeId, 'pending')
        }
      } finally {
        if (mounted.current) setThinking(false)
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
    thinking,
    error,
    send,
    upload,
    confirm,
    showError
  }
}
