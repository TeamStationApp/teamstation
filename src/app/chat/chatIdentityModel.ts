import { compareUserIds } from '../../common/chatCrypto/userId'
import { initialsOf } from '../components/initials'
import {
  groupTile,
  groupTint,
  personTile,
  teamTint
} from '../components/teamTile'
import { lstrings } from '../locales/strings'
import type { ConversationListItem, MemberView } from './engine/engine'

export interface ChatIdentityTile {
  key: string
  name: string
  initials: string
  /** None for the theme's neutral tile. */
  tint: string | undefined
  uri: string | null
}

export interface ChatIdentity {
  label: string
  tiles: ChatIdentityTile[]
}

/**
 * A current person's tile is the one they have everywhere else
 * (`PersonEmblem`): the initials of the name the chat shows on the colour of
 * their id (`personTint`). A former member keeps one tile of their own.
 */
export function memberIdentity(
  member: Pick<MemberView, 'userId' | 'shortName' | 'avatarUrl'> | undefined
): ChatIdentity {
  if (member == null) {
    const name = lstrings.chat_former_member
    return {
      label: name,
      tiles: [
        {
          key: 'former-member',
          name,
          initials: initialsOf(name),
          tint: teamTint('former-member'),
          uri: null
        }
      ]
    }
  }
  const userId = String(member.userId)
  const tile = personTile({ userId, name: member.shortName })
  return {
    label: member.shortName,
    tiles: [
      {
        key: userId,
        name: member.shortName,
        initials: tile.initials,
        tint: tile.tint,
        uri: member.avatarUrl ?? null
      }
    ]
  }
}

/** Scope subgroups share their scope's tile; a DM shows its current people. */
export function conversationIdentity(chat: ConversationListItem): ChatIdentity {
  if (chat.kind !== 'dm' && chat.scope != null) {
    const { scope } = chat
    const name = chat.avatarName ?? chat.scopeName ?? chat.title
    // The tile a team, league or season has everywhere else (`GroupEmblem`).
    const group = {
      kind: scope.type,
      id: scope.id,
      leagueId: chat.leagueId,
      name,
      uri: chat.avatarUrl,
      leagueUri: chat.leaguePictureUrl
    }
    const tile = groupTile(group)
    return {
      label: name,
      tiles: [
        {
          key: `${scope.type}:${scope.id}`,
          name,
          initials: tile.initials,
          tint: groupTint(group),
          uri: tile.uri
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
