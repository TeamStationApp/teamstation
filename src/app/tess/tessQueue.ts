import type { TessAttachmentRef, TessMessage } from './tessTypes'

/**
 * A message the person sent while Tess was answering, waiting its turn.
 * `seq` is fixed when it is first queued and orders it among the others
 * for as long as it lives, edits included.
 */
export interface QueuedMessage {
  id: string
  text: string
  attachments: TessAttachmentRef[]
  seq: number
  /** Why it failed when it went out: it waits at the head until handled. */
  error?: string
  /**
   * The client id it went out with, when the chat closed before it learnt
   * whether the server had it: it waits at the head until the conversation,
   * read again, says (`resolvedUnsure`).
   */
  unsure?: string
}

/**
 * The queue with `message` at its place by `seq`: before the first one
 * queued after it, else at the end. A new message, whose `seq` is the
 * highest yet, goes to the end; an edited one goes back where it was, or as
 * near as the ones still waiting allow.
 */
export function enqueue(
  queue: readonly QueuedMessage[],
  message: QueuedMessage
): QueuedMessage[] {
  const at = queue.findIndex(waiting => waiting.seq > message.seq)
  return at < 0
    ? [...queue, message]
    : [...queue.slice(0, at), message, ...queue.slice(at)]
}

/** The queue without the message `id`. */
export function withoutQueued(
  queue: readonly QueuedMessage[],
  id: string
): QueuedMessage[] {
  return queue.filter(waiting => waiting.id !== id)
}

/**
 * The queue with `message`, which failed going out, at its head, carrying
 * why: the queue stops there until it is edited, removed or sent again.
 */
export function failedAtHead(
  queue: readonly QueuedMessage[],
  message: QueuedMessage,
  error: string
): QueuedMessage[] {
  return [{ ...message, error }, ...withoutQueued(queue, message.id)]
}

/**
 * The queue with `message` back at its head, sent as `clientId` with the
 * chat closed before it learnt whether the server had it: neither dropped
 * nor sent again until the conversation says.
 */
export function unsureAtHead(
  queue: readonly QueuedMessage[],
  message: QueuedMessage,
  clientId: string
): QueuedMessage[] {
  return [{ ...message, unsure: clientId }, ...withoutQueued(queue, message.id)]
}

/**
 * The queue once its head, if it is unsure (`unsureAtHead`), is looked for
 * in `messages`, the conversation as the server has it: found, it reached
 * Tess, and it goes; not found, it stays at the head with `error`, for the
 * person to send again or remove, since it is never sent twice unasked.
 * The same queue when its head is not unsure.
 */
export function resolvedUnsure(
  queue: readonly QueuedMessage[],
  messages: readonly TessMessage[],
  error: string
): readonly QueuedMessage[] {
  const head = queue[0]
  if (head?.unsure == null) return queue
  const { unsure, ...message } = head
  const reached = messages.some(
    shown => shown.role === 'user' && shown.clientId === unsure
  )
  return reached ? queue.slice(1) : [{ ...message, error }, ...queue.slice(1)]
}

/**
 * Whether the latest turn, everything after the person's last message, has
 * a change still waiting for its hold: the queue waits for the person to
 * hold it, or to send something that declines it.
 */
export function awaitingHold(messages: readonly TessMessage[]): boolean {
  for (let at = messages.length - 1; at >= 0; at--) {
    const message = messages[at]
    if (message.role === 'user') return false
    if (message.changes.some(change => change.status === 'pending')) return true
  }
  return false
}

/**
 * When each pending change expires, by this device's clock, in
 * milliseconds: `received` (when it reached the chat) plus the time the
 * server said it had left (`expiresInMs`), since the device's clock need
 * not agree with the server's. Each is set once, when first seen, in
 * `deadlines`, which it answers.
 */
export function stampDeadlines(
  messages: readonly TessMessage[],
  deadlines: Map<string, number>,
  received: number
): Map<string, number> {
  for (const message of messages)
    for (const change of message.changes)
      if (
        change.status === 'pending' &&
        change.expiresInMs != null &&
        !deadlines.has(change.id)
      )
        deadlines.set(change.id, received + change.expiresInMs)
  return deadlines
}

/**
 * When the first of the pending changes expires, in this device's
 * milliseconds (`deadlines`), of those that say: the queue waits for none
 * past it, so the chat looks again then.
 */
export function firstExpiry(
  messages: readonly TessMessage[],
  deadlines: ReadonlyMap<string, number>
): number | null {
  let first: number | null = null
  for (const message of messages)
    for (const change of message.changes) {
      if (change.status !== 'pending') continue
      const at = deadlines.get(change.id)
      if (at != null && (first == null || at < first)) first = at
    }
  return first
}

/**
 * The messages with every pending change due by `at` (`deadlines`)
 * expired, as the server holds them unconfirmed past their time: none
 * awaits a hold that can only be refused, and the queue goes on. The same
 * messages when none is due.
 */
export function expiredBy(
  messages: TessMessage[],
  at: number,
  deadlines: ReadonlyMap<string, number>
): TessMessage[] {
  const due = (change: TessMessage['changes'][number]): boolean => {
    const deadline = deadlines.get(change.id)
    return change.status === 'pending' && deadline != null && deadline <= at
  }
  if (!messages.some(message => message.changes.some(due))) return messages
  return messages.map(message =>
    message.changes.some(due)
      ? {
          ...message,
          changes: message.changes.map(change =>
            due(change) ? { ...change, status: 'expired' as const } : change
          )
        }
      : message
  )
}

/**
 * The message to send once Tess is done, if one may go: the head of the
 * queue, unless it failed going out, may have gone out already (`unsure`)
 * or her latest turn awaits a hold.
 */
export function nextToDrain(
  queue: readonly QueuedMessage[],
  messages: readonly TessMessage[]
): QueuedMessage | null {
  const head = queue[0]
  if (
    head == null ||
    head.error != null ||
    head.unsure != null ||
    awaitingHold(messages)
  )
    return null
  return head
}

/**
 * A person's queue, kept apart from the chat that shows it: closing the
 * chat while Tess answers keeps what waits, and it goes out once the chat
 * is open again. `lastSeq` is the last place given; `forced` holds the
 * messages sent now while a turn was out, which go first once it ends;
 * `editing` is the one taken out to be edited, as it was, for which the
 * queue waits, so none behind it goes first. `working` counts the messages
 * and confirms out, until each settles, whether or not the chat that sent
 * it is still open, so a chat opened meanwhile sends nothing past one, and
 * `running` is the client id of the one out, which a stop names from any
 * chat open meanwhile; `unseen` counts those that settled with their chat closed, which a chat
 * open then reads the conversation again for. `listeners` are the open
 * chats, told of every change (`storeChanged`).
 */
export interface QueueStore {
  queue: QueuedMessage[]
  lastSeq: number
  forced: QueuedMessage[]
  editing: QueuedMessage | null
  working: number
  running: string | null
  unseen: number
  listeners: Set<() => void>
}

/** Has `listener` told of each change to `store`; answers what stops it. */
export function subscribeStore(
  store: QueueStore,
  listener: () => void
): () => void {
  store.listeners.add(listener)
  return () => {
    store.listeners.delete(listener)
  }
}

/** Tells the chats open on `store` that it changed. */
export function storeChanged(store: QueueStore): void {
  for (const listener of [...store.listeners]) listener()
}

/** The queues of the people signed in since the app started, by user. */
const stores = new Map<string, QueueStore>()

/**
 * The queue of `owner`, the signed-in user, kept for as long as the app
 * runs, so no other account sees it. With no owner, one of its own, which
 * lives as long as the chat that asked for it.
 */
export function queueStore(owner: string | undefined): QueueStore {
  const fresh = (): QueueStore => ({
    queue: [],
    lastSeq: 0,
    forced: [],
    editing: null,
    working: 0,
    running: null,
    unseen: 0,
    listeners: new Set()
  })
  if (owner == null) return fresh()
  let store = stores.get(owner)
  if (store == null) {
    store = fresh()
    stores.set(owner, store)
  }
  return store
}

/** Forgets every queue: the person signed out, or their account went. */
export function forgetQueues(): void {
  stores.clear()
}
