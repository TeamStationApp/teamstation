import { compareUserIds } from '../../common/chatCrypto/userId'
import { initialsOf } from '../components/initials'
import { teamInitialsOf, teamTint } from '../components/teamTile'
import { lstrings } from '../locales/strings'
import type { ConversationListItem, MemberView } from './engine/engine'

export interface ChatIdentityTile {
  key: string
  name: string
  initials: string
  tint: string
  uri: string | null
}

export interface ChatIdentity {
  label: string
  tiles: ChatIdentityTile[]
}

/** A current person's tile is the same in every chat surface. */
export function memberIdentity(
  member: Pick<MemberView, 'userId' | 'shortName' | 'avatarUrl'> | undefined
): ChatIdentity {
  const name = member?.shortName ?? lstrings.chat_former_member
  const key = member == null ? 'former-member' : String(member.userId)
  return {
    label: name,
    tiles: [
      {
        key,
        name,
        initials: initialsOf(name),
        tint: teamTint(key),
        uri: member?.avatarUrl ?? null
      }
    ]
  }
}

/** Scope subgroups share their scope's tile; a DM shows its current people. */
export function conversationIdentity(chat: ConversationListItem): ChatIdentity {
  if (chat.kind !== 'dm' && chat.scope != null) {
    const name = chat.avatarName ?? chat.scopeName ?? chat.title
    return {
      label: name,
      tiles: [
        {
          key: `${chat.scope.type}:${chat.scope.id}`,
          name,
          initials:
            chat.scope.type === 'team'
              ? teamInitialsOf(name)
              : initialsOf(name),
          tint: teamTint(chat.scope.id),
          uri: chat.avatarUrl ?? null
        }
      ]
    }
  }
  const current = [
    ...new Map(
      (chat.people ?? [])
        .filter(person => !person.left)
        .map(person => [person.userId, person])
    ).values()
  ].sort((a, b) => compareUserIds(a.userId, b.userId))
  if (current.length > 0) {
    return {
      label: current.map(person => person.shortName).join(', '),
      tiles: current.map(person => memberIdentity(person).tiles[0])
    }
  }
  if (chat.people != null && chat.people.length > 0)
    return memberIdentity(undefined)
  return {
    label: chat.title,
    tiles: [
      {
        key: chat.id,
        name: chat.title,
        initials: initialsOf(chat.title),
        tint: teamTint(chat.id),
        uri: chat.people == null ? (chat.avatarUrl ?? null) : null
      }
    ]
  }
}
