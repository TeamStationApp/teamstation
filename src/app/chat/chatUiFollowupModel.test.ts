import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { ChatPreferences } from '../../common/api'
import type { AttachmentRef } from '../../common/chatContent'
import { lstrings } from '../locales/strings'
import {
  conversationPill,
  conversationTitle,
  groupChats,
  hasUnread,
  messagePreview
} from './chatModel'
import { chat, message } from './chatViews.test.helpers'
import { emptyChatDraft, newChatWorkspaceState } from './chatWorkspaceModel'
import type { ConversationListItem } from './engine/engine'

const scoped = (
  over: Partial<ConversationListItem> = {}
): ConversationListItem =>
  chat({
    title: 'Aurora Members',
    scopeName: 'Aurora',
    scope: { type: 'team', id: 'tem_aurora' },
    ...over
  })

const prefs = (pinned = false): ChatPreferences => ({
  pinned,
  muted: false,
  manualUnread: false,
  manualUnreadRevision: 0
})

function file(contentType: string, fileName: string): AttachmentRef {
  return {
    id: 'att_fixture',
    key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    digest: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    size: 3,
    contentType,
    fileName
  }
}

describe('chat UI follow-up model', function () {
  it('owns each workspace and conversation draft independently', function () {
    const first = newChatWorkspaceState()
    const second = newChatWorkspaceState()
    const a = emptyChatDraft()
    const b = emptyChatDraft()
    a.text = 'Bring water'
    a.picked.push({
      bytes: new Uint8Array([1]),
      contentType: 'text/plain',
      fileName: 'notes.txt'
    })
    a.replyTo = message({ senderName: 'Mookie Betts' })
    a.scrollOffset = 144
    first.drafts.set('cnv_aurora', a)
    first.drafts.set('cnv_solstice', b)
    first.listOffset = 32
    first.selectedId = 'cnv_aurora'
    expect(second.drafts.size).equals(0)
    expect(second.listOffset).equals(0)
    expect(second.selectedId).equals(undefined)
    expect(b).deep.equals({ text: '', picked: [], scrollOffset: 0 })
    expect(first.drafts.get('cnv_aurora')?.replyTo?.senderName).equals(
      'Mookie Betts'
    )
  })

  it('ranks the four personal bands without unread priority or mutating the input', function () {
    const old = '2027-04-01T12:00:00.000Z'
    const newer = '2027-04-02T12:00:00.000Z'
    const source = [
      scoped({ id: 'regular-group-unread', lastPostAt: old, unread: 99 }),
      scoped({
        id: 'pinned-group',
        preferences: prefs(true),
        lastPostAt: newer
      }),
      scoped({ id: 'regular-dm', kind: 'dm', scope: null, lastPostAt: old }),
      scoped({ id: 'regular-group-new', lastPostAt: newer }),
      scoped({
        id: 'pinned-dm',
        kind: 'dm',
        scope: null,
        preferences: prefs(true)
      })
    ]
    const original = source.map(item => item.id)
    const groups = groupChats(source)
    expect(groups.map(group => group.title)).deep.equals(['Pinned', 'Chats'])
    expect(
      groups.flatMap(group => group.chats.map(item => item.id))
    ).deep.equals([
      'pinned-dm',
      'pinned-group',
      'regular-dm',
      'regular-group-new',
      'regular-group-unread'
    ])
    expect(source.map(item => item.id)).deep.equals(original)
  })

  it('uses post recency, keeps ties deterministic, and omits empty bands', function () {
    const groups = groupChats([
      scoped({
        id: 'c',
        lastPostAt: null,
        lastMessageAt: '2027-05-01T00:00:00Z'
      }),
      scoped({ id: 'b', lastPostAt: 'not-a-date' }),
      scoped({ id: 'a', lastPostAt: null }),
      scoped({ id: 'post', lastPostAt: '2027-04-01T00:00:00Z' }),
      scoped({ id: 'legacy', lastMessageAt: '2027-04-02T00:00:00Z' })
    ])
    expect(groups.map(group => group.key)).deep.equals(['chats'])
    expect(groups[0].chats.map(item => item.id)).deep.equals([
      'legacy',
      'post',
      'a',
      'b',
      'c'
    ])
    expect(groupChats([])).deep.equals([])
    expect(
      groupChats([scoped({ preferences: prefs(true) })]).map(g => g.key)
    ).deep.equals(['pinned'])
  })

  it('keeps direct-message titles and separates every scope from its subgroup pill', function () {
    const cases: Array<
      [ConversationListItem['kind'], 'team' | 'season' | 'league', string]
    > = [
      ['leagueOrg', 'league', 'League Org'],
      ['seasonStaff', 'season', 'Season Staff'],
      ['seasonAllStaff', 'season', 'Season All Staff'],
      ['seasonAnnouncements', 'season', 'Season Announcements'],
      ['teamStaff', 'team', 'Team Staff'],
      ['teamMembers', 'team', 'Team Members'],
      ['teamFans', 'team', 'Team Fans']
    ]
    for (const [kind, type, pill] of cases) {
      const item = scoped({ kind, scope: { type, id: 'scope_fixture' } })
      expect(conversationTitle(item)).equals('Aurora')
      expect(conversationPill(item)).equals(pill)
    }
    const direct = scoped({
      kind: 'dm',
      scope: null,
      title: 'Mookie Betts, Trea Turner'
    })
    expect(conversationTitle(direct)).equals('Mookie Betts, Trea Turner')
    expect(conversationPill(direct)).equals(undefined)
    const unnamedScope = scoped({ scopeName: null, title: 'Aurora Fans' })
    expect(conversationTitle(unnamedScope)).equals('Aurora Fans')
    expect(conversationTitle(scoped({ scope: null }))).equals('Aurora Members')
    expect(conversationPill(scoped({ scope: null }))).equals(undefined)
  })

  it('shows accessible local content and never previews unavailable plaintext', function () {
    const body = 'Bring water and a glove.'
    expect(messagePreview(message({ body }))).equals(body)
    expect(messagePreview(undefined)).equals(lstrings.chat_message_unavailable)
    const statuses = {
      removed: lstrings.chat_removed_author,
      locked: lstrings.chat_locked_message,
      lost: lstrings.chat_lost_message,
      invalid: lstrings.chat_invalid_message
    } as const
    for (const status of Object.keys(statuses) as Array<
      keyof typeof statuses
    >) {
      const preview = messagePreview(message({ status, body }))
      expect(preview).equals(statuses[status])
      expect(preview).not.contains(body)
    }
  })

  it('summarizes attachment-only posts without reading or exposing attachment bytes', function () {
    const image = file('image/jpeg', 'photo.jpg')
    const video = file('video/mp4', 'clip.mp4')
    const notes = file('text/plain', 'notes.txt')
    expect(messagePreview(message({ body: '', attachments: [image] }))).equals(
      lstrings.chat_photo_label
    )
    expect(messagePreview(message({ body: '', attachments: [video] }))).equals(
      lstrings.chat_video_label
    )
    expect(messagePreview(message({ body: '', attachments: [notes] }))).equals(
      `${lstrings.chat_file}: notes.txt`
    )
    expect(
      messagePreview(message({ body: '', attachments: [image, video] }))
    ).equals(`2 ${lstrings.chat_attachments_label}`)
    expect(messagePreview(message({ body: '', attachments: [] }))).equals(
      lstrings.chat_message_unavailable
    )
  })

  it('includes manual unread in the tab indicator independently of message counts', function () {
    expect(hasUnread([scoped()])).equals(false)
    expect(hasUnread([scoped({ unread: 1 })])).equals(true)
    expect(
      hasUnread([scoped({ preferences: { ...prefs(), manualUnread: true } })])
    ).equals(true)
  })
})
