import {
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'

import { TessTurnError } from '../../common/api'
import { type ErrorCode, HttpError } from '../../common/errors'
import { lstrings } from '../locales/strings'
import {
  enqueue,
  expiredBy,
  failedAtHead,
  firstExpiry,
  nextToDrain,
  type QueuedMessage,
  queueStore,
  resolvedUnsure,
  stampDeadlines,
  storeChanged,
  subscribeStore,
  unsureAtHead,
  withoutQueued
} from './tessQueue'
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
   * and until it is answered nothing else is confirmed, and a message sent
   * waits in the queue.
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
  /**
   * Sends a message, or queues it while Tess answers or others wait: answers
   * whether it reached Tess or the queue. `seq` is an edited message's place
   * in the queue (`editQueued`), which it goes back to.
   */
  send: (
    text: string,
    attachments: TessAttachmentRef[],
    options?: { seq?: number }
  ) => Promise<boolean>
  /** The messages waiting for Tess, in the order they go out. */
  queued: readonly QueuedMessage[]
  /**
   * Sends the queued message `id` now: stops her turn, if one is out, and
   * sends it once it has ended, ahead of the rest, which keep their order.
   * Changes awaiting a hold are declined, as any message declines them.
   */
  sendNow: (id: string) => Promise<void>
  /** Takes the queued message `id` out of the queue. */
  unqueue: (id: string) => void
  /**
   * Takes the queued message `id` out of the queue to be edited: its words,
   * its files and its place, for `send` to put it back. Null when it has
   * gone out already. Until it is sent again, another is taken to edit or
   * the chat closes, the queue waits for it, its field emptied or not, so
   * the ones behind it keep their order. One already out for editing goes
   * back to its place first, as `draft`, the composer's words and files
   * now, has it (as it was, when that is empty).
   */
  editQueued: (
    id: string,
    draft?: { text: string; attachments: TessAttachmentRef[] }
  ) => { text: string; attachments: TessAttachmentRef[]; seq: number } | null
  upload: (upload: TessUpload) => Promise<TessAttachmentRef | null>
  /**
   * Runs a turn's pending changes, held as one, in order, and Tess reports
   * on them together.
   */
  confirmAll: (changeIds: string[]) => Promise<void>
  /**
   * Stops the turn this chat sent, a message or a confirm, or the one the
   * server named as running when the chat opened: the server ends it, and
   * her reply ends as far as it went, marked stopped. Nothing while no turn
   * is known.
   */
  stop: () => Promise<void>
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

/** The messages with each of `changes` as it is now, by id. */
function withChanges(
  messages: TessMessage[],
  changes: readonly TessChange[]
): TessMessage[] {
  const byId = new Map(changes.map(change => [change.id, change]))
  return messages.map(message =>
    message.changes.some(change => byId.has(change.id))
      ? {
          ...message,
          changes: message.changes.map(change => byId.get(change.id) ?? change)
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
 * change, or a batch of them (`confirmAll`), shows how each ended before her
 * report on them.
 *
 * Each message and confirm goes with an id of its own, and `stop` names the
 * one out: the server stops that turn, and its stream ends as any answer
 * does, her reply as far as it went and marked stopped. A chat opened while
 * she answers names the turn by the id the server answers with it, so Stop
 * and `sendNow` work there too.
 *
 * A message sent while she answers, or while others wait, is queued
 * (`tessQueue`), in the signed-in person's store (`owner`), which outlives
 * the chat: closed, nothing goes, and opened again the queue shows as it
 * was and goes on. Once she is done the first goes out, one at a time, unless
 * her latest turn has changes awaiting a hold (until they expire, as long
 * after the chat received them as the server said they had left) or it
 * failed going out before:
 * one that fails goes back to the head with why, and the queue waits for the
 * person to edit it, remove it or send it again with `sendNow`. While one is
 * out to be edited the queue waits for it too, and a chat closed meanwhile
 * puts it back as it was. One that went out with the chat then closed
 * before it learnt whether the server had it goes back to the head, unsure:
 * opened again, the chat looks for it in the conversation by the id it went
 * with, and drops it from the queue when it is there, or else keeps it at
 * the head with an error, for the person to send again or remove; it is
 * never sent twice unasked. A message or confirm counts as out, in the
 * store, until it settles, though the chat that sent it has closed: a chat
 * opened meanwhile sends nothing past it, draws what becomes of it in the
 * queue, and reads the conversation again once it has settled.
 */
export function useTess(
  api: TessApi,
  options: {
    screen?: () => TessScreen | undefined
    /** The signed-in user, whose queue this chat shows. */
    owner?: string
  } = {}
): TessChatState {
  const [loading, setLoading] = useState(true)
  const [messages, setMessages] = useState<TessMessage[]>([])
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  // The client id of the turn the server named as running when the chat
  // opened, which a stop names when no message or confirm is out.
  const running = useRef<string | null>(null)
  const pendingId = useRef(0)
  // The queue, kept in the person's store, read between renders as well as
  // drawn as the store has it; and the messages `sendNow` named while a
  // turn was out, sent first once it ends.
  const store = useMemo(() => queueStore(options.owner), [options.owner])
  const subscribe = useCallback(
    (listener: () => void) => subscribeStore(store, listener),
    [store]
  )
  const queued: readonly QueuedMessage[] = useSyncExternalStore(
    subscribe,
    () => store.queue
  )
  // Messages and confirms with the server, counted in the store until each
  // settles, a closed chat's too: the server takes one turn at a time, so
  // nothing more is sent while any is out. And the reads of a turn this
  // chat only watches, counted here.
  const sent = useSyncExternalStore(subscribe, () => store.working)
  const watching = useRef(0)
  const [watched, setWatched] = useState(0)
  const inFlight = sent + watched
  const busy = useCallback(
    (): boolean => store.working > 0 || watching.current > 0,
    [store]
  )
  // The place of the message out to be edited, drawn as the store has it.
  const [editing, setEditing] = useState<number | null>(null)
  const [shownStore, setShownStore] = useState(store)
  if (shownStore !== store) {
    setShownStore(store)
    setEditing(null)
  }
  // Kept in the store when the chat has closed, for when it opens again.
  const updateQueue = useCallback(
    (change: (current: QueuedMessage[]) => QueuedMessage[]): void => {
      store.queue = change(store.queue)
      storeChanged(store)
    },
    [store]
  )
  const editingAs = useCallback(
    (message: QueuedMessage | null): void => {
      store.editing = message
      setEditing(message?.seq ?? null)
    },
    [store]
  )
  // Closed with a message out to be edited: its draft goes with the
  // composer, and the message goes back as it was.
  useEffect(
    () => () => {
      const { editing } = store
      if (editing == null) return
      store.editing = null
      store.queue = enqueue(store.queue, editing)
      storeChanged(store)
    },
    [store]
  )
  const screen = useRef(options.screen)
  screen.current = options.screen

  const begin = useCallback((): void => {
    store.working += 1
    storeChanged(store)
  }, [store])
  // Settled with the chat closed, it is unseen: a chat open now reads the
  // conversation again for it.
  const end = useCallback((): void => {
    if (!mounted.current) store.unseen += 1
    store.working -= 1
    storeChanged(store)
  }, [store])
  const beginWatching = (): void => {
    watching.current += 1
    setWatched(count => count + 1)
  }
  const endWatching = (): void => {
    watching.current -= 1
    if (mounted.current) setWatched(count => count - 1)
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
        // Opened while she answers: her answer shows when she is done, and
        // the turn the server names is this chat's to stop.
        beginWatching()
        const { turnClientId } = conversation
        if (turnClientId != null) running.current = turnClientId
        const ended = (): void => {
          if (running.current === turnClientId) running.current = null
          endWatching()
        }
        settledConversation(api, mounted, conversation).then(settled => {
          if (settled != null && mounted.current) setMessages(settled.messages)
          ended()
        }, ended)
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

  // A message or confirm a closed chat sent settled while this one is open:
  // what it did shows once the conversation is read again, and until then
  // nothing more goes.
  useEffect(() => {
    let seen = store.unseen
    return subscribeStore(store, () => {
      if (store.unseen === seen) return
      seen = store.unseen
      beginWatching()
      settledConversation(api, mounted).then(settled => {
        if (settled != null && mounted.current) setMessages(settled.messages)
        endWatching()
      }, endWatching)
    })
  }, [api, store])

  /**
   * Sends a message while nothing else is out: answers whether it reached
   * Tess, and tells `refused` why when it did not and was taken back, and
   * `unsure` the client id it went with when the chat closed before it
   * could learn which.
   */
  const post = useCallback(
    async (
      text: string,
      attachments: TessAttachmentRef[],
      refused: (message: string) => void,
      unsure?: (clientId: string) => void
    ): Promise<boolean> => {
      begin()
      const clientId = newClientId()
      store.running = clientId
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
        // The server says whether it has the message; a lost stream cannot.
        // One refused is told even once the chat has closed: a queued one
        // goes back to the head of the queue, kept for the chat's return.
        const told = failure instanceof TessTurnError ? failure.kept : null
        if (
          told === false ||
          (!stored &&
            failure instanceof HttpError &&
            REFUSED_UNSTORED.includes(failure.code))
        ) {
          refused(messageOf(failure))
          if (mounted.current) takeBack()
          return false
        }
        // Closed, the chat cannot look: unless the server told it stored
        // the message, whether it did is left for the chat's return.
        const closed = (): false => {
          if (!stored && told !== true) unsure?.(clientId)
          return false
        }
        if (!mounted.current) return closed()
        const conversation = await settledConversation(api, mounted)
        if (!mounted.current) return closed()
        if (conversation == null) {
          // Kept, it stays as the server showed it, and is not sent twice.
          if (stored || told === true) {
            setError(messageOf(failure))
            return true
          }
          refused(messageOf(failure))
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
        // Kept: it reached Tess, and is not given back to send twice.
        if (at < 0) {
          refused(messageOf(failure))
          return false
        }
        if (!answered) setError(messageOf(failure))
        return true
      } finally {
        if (answer != null) stopTelling(answer)
        if (store.running === clientId) store.running = null
        end()
      }
    },
    [api, begin, end, store, tell, stopTelling]
  )

  const send = useCallback(
    async (
      text: string,
      attachments: TessAttachmentRef[],
      options: { seq?: number } = {}
    ) => {
      // The message out to be edited, sent again: the queue goes on.
      const edited =
        options.seq != null && store.editing?.seq === options.seq
          ? store.editing
          : null
      if (edited != null) editingAs(null)
      if (busy() || store.queue.length > 0) {
        const seq = options.seq ?? (store.lastSeq += 1)
        updateQueue(current =>
          enqueue(current, { id: `q${seq}`, text, attachments, seq })
        )
        return true
      }
      const posted = await post(text, attachments, setError)
      // Given back to the composer, it is still being edited.
      if (!posted && edited != null && store.editing == null && mounted.current)
        editingAs(edited)
      return posted
    },
    [busy, editingAs, post, store, updateQueue]
  )

  /**
   * Sends a queued message; one that fails goes back to the head, and so
   * does one whose fate the chat closed before learning, unsure.
   */
  const release = useCallback(
    (message: QueuedMessage): void => {
      const going: QueuedMessage = {
        id: message.id,
        text: message.text,
        attachments: message.attachments,
        seq: message.seq
      }
      post(
        going.text,
        going.attachments,
        why => {
          updateQueue(current => failedAtHead(current, going, why))
        },
        clientId => {
          updateQueue(current => unsureAtHead(current, going, clientId))
        }
      ).catch(() => undefined)
    },
    [post, updateQueue]
  )

  // Once she is done, the next message goes: one the person sent now, or
  // the queue's head, as `nextToDrain` allows. A head left unsure by a chat
  // closed while it was out is first looked for in the conversation.
  useEffect(() => {
    if (loading || inFlight > 0 || busy()) return
    if (store.queue[0]?.unsure != null) {
      updateQueue(current => [
        ...resolvedUnsure(current, messages, lstrings.tess_queue_unsure)
      ])
      return
    }
    const next =
      store.forced.shift() ??
      (store.editing == null ? nextToDrain(store.queue, messages) : null)
    if (next == null) return
    updateQueue(current => withoutQueued(current, next.id))
    release(next)
  }, [
    busy,
    loading,
    inFlight,
    queued,
    editing,
    messages,
    release,
    store,
    updateQueue
  ])

  // A pending change expires unconfirmed on the server at its time, and
  // here then too, so the queue waiting for its hold goes on: counted from
  // when the chat received it, by the time the server said it had left,
  // since this device's clock need not agree with the server's.
  const deadlines = useRef(new Map<string, number>())
  useEffect(() => {
    const due = firstExpiry(
      messages,
      stampDeadlines(messages, deadlines.current, Date.now())
    )
    if (due == null) return
    const timer = setTimeout(
      () => {
        setMessages(current => expiredBy(current, due, deadlines.current))
      },
      Math.max(0, due - Date.now())
    )
    return () => {
      clearTimeout(timer)
    }
  }, [messages])

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

  const confirmAll = useCallback(
    async (changeIds: string[]) => {
      if (busy() || changeIds.length === 0) return
      begin()
      const clientId = newClientId()
      store.running = clientId
      const ids = new Set(changeIds)
      const setStatuses = (status: TessChangeStatus): void => {
        setMessages(current =>
          withChanges(
            current,
            current.flatMap(message =>
              message.changes.flatMap(change =>
                ids.has(change.id) ? [{ ...change, status }] : []
              )
            )
          )
        )
      }
      setStatuses('running')
      setError(null)
      let answered: TessMessage[] | undefined
      // How the changes ended, as the server told it before she reports.
      let told = false
      try {
        const answer = await api.streamTessConfirmAll(
          changeIds,
          tell(stored => {
            const { changes } = stored
            if (changes == null) return
            told = true
            setMessages(current => withChanges(current, changes))
          }),
          { clientId }
        )
        answered = answer.messages
        if (mounted.current)
          setMessages(current =>
            merged(withChanges(current, answer.changes), answer.messages)
          )
      } catch (failure) {
        stopTelling()
        if (!mounted.current) return
        setError(messageOf(failure))
        // As for one change: what the server says once Tess is done, or
        // what it already told, or the hold again when it can be asked
        // neither.
        const conversation = await settledConversation(api, mounted)
        if (!mounted.current) return
        if (conversation != null) setMessages(conversation.messages)
        else if (!told) setStatuses('pending')
      } finally {
        if (answered != null) stopTelling(answered)
        if (store.running === clientId) store.running = null
        end()
      }
    },
    [api, begin, busy, end, store, tell, stopTelling]
  )

  // The message or confirm out, though a chat since closed sent it, or
  // else the turn the server named.
  const stop = useCallback(async () => {
    const clientId = store.running ?? running.current
    if (clientId == null) return
    try {
      await api.stopTess(clientId)
    } catch (failure) {
      if (mounted.current) setError(messageOf(failure))
    }
  }, [api, store])

  const sendNow = useCallback(
    async (id: string) => {
      const message = store.queue.find(waiting => waiting.id === id)
      if (message == null) return
      updateQueue(current => withoutQueued(current, id))
      if (!busy()) {
        release(message)
        return
      }
      store.forced.push(message)
      await stop()
    },
    [busy, release, stop, store, updateQueue]
  )

  const unqueue = useCallback(
    (id: string) => {
      updateQueue(current => withoutQueued(current, id))
    },
    [updateQueue]
  )

  const editQueued = useCallback(
    (
      id: string,
      draft?: { text: string; attachments: TessAttachmentRef[] }
    ) => {
      const message = store.queue.find(waiting => waiting.id === id)
      if (message == null) return null
      // One already out for editing, whose draft this one replaces, goes
      // back to its place as edited so far.
      const out = store.editing
      const text = draft?.text.trim() ?? ''
      const back =
        out == null
          ? null
          : draft == null || (text === '' && draft.attachments.length === 0)
            ? out
            : { ...out, text, attachments: draft.attachments }
      updateQueue(current => {
        const rest = withoutQueued(current, id)
        return back == null ? rest : enqueue(rest, back)
      })
      editingAs(message)
      return {
        text: message.text,
        attachments: message.attachments,
        seq: message.seq
      }
    },
    [editingAs, store, updateQueue]
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
    queued,
    sendNow,
    unqueue,
    editQueued,
    upload,
    confirmAll,
    stop,
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
