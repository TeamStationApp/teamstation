import { loadChatCore } from '../../common/chatCrypto/core'
import type { GroupRef } from '../../common/groupCreation'
import type { ChatLink } from './ChatLinks'
import type { ChatEngine, ConversationListItem } from './engine/engine'
import type { ChatKeyStore } from './keyRecord'

const GROUP_LABELS: Record<ConversationListItem['kind'], string> = {
  leagueOrg: 'Org',
  leagueUmpires: 'Umpires',
  seasonStaff: 'Staff',
  seasonAllStaff: 'All Staff',
  seasonAnnouncements: 'Announcements',
  teamStaff: 'Staff',
  teamMembers: 'Members',
  teamFans: 'Fans',
  dm: ''
}

/** Membership is decided by the server's list, not the page's management role. */
export function entityChats(
  conversations: ConversationListItem[],
  group: GroupRef
): ChatLink[] {
  return conversations
    .filter(
      chat =>
        chat.kind !== 'dm' &&
        chat.scope?.type === group.kind &&
        chat.scope.id === group.id
    )
    .map(chat => ({
      id: chat.id,
      title: chat.title,
      label: GROUP_LABELS[chat.kind],
      preview:
        chat.previewReadable === true &&
        !chat.locked &&
        !chat.unverified &&
        chat.previewFailed !== true &&
        chat.preview?.trim() !== ''
          ? chat.preview
          : undefined
    }))
}

/**
 * The league's umpire chat in the reader's list, which holds it only while
 * they are one of its members, under the server's title ("QPLL Umpires").
 */
export function umpireChatOf(
  conversations: ConversationListItem[],
  leagueId: string
): { id: string; title: string } | undefined {
  const chat = conversations.find(
    item =>
      item.kind === 'leagueUmpires' &&
      item.scope?.type === 'league' &&
      item.scope.id === leagueId
  )
  return chat == null ? undefined : { id: chat.id, title: chat.title }
}

/** Restore an already-linked device for previews; never enrol from a group page. */
export function entityPreviewLoader(
  engine: Pick<ChatEngine, 'status' | 'start' | 'loadPreview'> | undefined,
  store: Pick<ChatKeyStore, 'load'>,
  userId: string | undefined,
  loadCore: typeof loadChatCore = loadChatCore
): (ids: string[]) => Promise<void> {
  /** Resolves `true` once settled for this page, `false` to try again. */
  let starting: Promise<boolean> | undefined
  return async ids => {
    if (engine == null || ids.length === 0) return
    if (engine.status === 'idle') {
      starting ??= (async () => {
        if (!(await loadCore()).ready) return false
        if (userId == null) return true
        const record = await store.load(userId)
        // No linked record here: nothing changes until this device links,
        // and linking starts the engine itself.
        if (
          record?.userId !== userId ||
          record?.identity == null ||
          record.puks.length === 0
        )
          return true
        await engine.start(true)
        return engine.status === 'ready'
      })()
      const mine = starting
      // A rejected start is tried again on the next call.
      const settled = await mine.catch(() => false)
      if (!settled && starting === mine) starting = undefined
    }
    if (engine.status !== 'ready') return
    await Promise.all(
      ids.map(async id => {
        await engine.loadPreview(id, false).catch(() => undefined)
      })
    )
  }
}
