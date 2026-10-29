import { loadChatCore } from '../../common/chatCrypto/core'
import type { GroupRef } from '../../common/groupCreation'
import type { ChatLink } from './ChatLinks'
import type { ChatEngine, ConversationListItem } from './engine/engine'
import type { ChatKeyStore } from './keyRecord'

const GROUP_LABELS: Record<ConversationListItem['kind'], string> = {
  leagueOrg: 'Org',
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

/** Restore an already-linked device for previews; never enrol from a group page. */
export function entityPreviewLoader(
  engine: Pick<ChatEngine, 'status' | 'start' | 'loadPreview'> | undefined,
  store: Pick<ChatKeyStore, 'load'>,
  userId: string | undefined,
  loadCore: typeof loadChatCore = loadChatCore
): (ids: string[]) => Promise<void> {
  let starting: Promise<void> | undefined
  return async ids => {
    if (engine == null || ids.length === 0) return
    if (engine.status === 'idle') {
      starting ??= (async () => {
        if (!(await loadCore()).ready) return
        const record = await store.load()
        if (
          record?.userId !== userId ||
          record?.identity == null ||
          record.puks.length === 0
        )
          return
        await engine.start(true)
      })().catch(() => undefined)
      await starting
    }
    if (engine.status !== 'ready') return
    await Promise.all(
      ids.map(async id => {
        await engine.loadPreview(id, false).catch(() => undefined)
      })
    )
  }
}
