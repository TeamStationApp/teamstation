import type { ChatKindName } from './api'

/**
 * The chat kinds a client reads beyond those every build has read, sent with
 * every request (`x-teamstation-chat-kinds: leagueUmpires`). A build from
 * before a kind cleans its conversation list strictly, so one conversation
 * of a kind it does not know would fail the whole list: the server leaves a
 * newer kind out for a client that does not name it, and a push registration
 * keeps what its app named, so a chat of a newer kind wakes only the devices
 * whose app lists it.
 */
export const CHAT_KINDS_HEADER = 'x-teamstation-chat-kinds'

/** The kinds added since the first eight, each named by the clients that read it. */
export const NEWER_CHAT_KINDS: readonly string[] = [
  'leagueUmpires'
] satisfies readonly ChatKindName[]

/** The newer kinds a client named in its header: those it reads. */
export function readChatKinds(header: string | undefined): string[] {
  const unread = unreadChatKinds(header)
  return NEWER_CHAT_KINDS.filter(kind => !unread.has(kind))
}

/** The newer kinds a client did not name in its header, to leave out for it. */
export function unreadChatKinds(header: string | undefined): Set<string> {
  const named = new Set((header ?? '').split(',').map(kind => kind.trim()))
  return new Set(NEWER_CHAT_KINDS.filter(kind => !named.has(kind)))
}
