import { expect } from 'chai'
import { describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import { contentTypeOf, safeFileName } from './chatFileTypes'
import {
  actionsFor,
  approvalsIn,
  canStartDm,
  groupChats,
  hasUnread,
  placeholderSize,
  readLine,
  safetyGroups,
  sizeLabel,
  swipeOffset,
  swipeReplies,
  timeLabel,
  typingNames
} from './chatModel'
import { chat, message } from './chatViews.test.helpers'
import type { GrantApproval, MemberView } from './engine/engine'

/** U13: what the chat screens decide without drawing anything. */

const member = (userId: string, shortName: string): MemberView => ({
  userId,
  shortName,
  avatarUrl: null,
  label: 'Member',
  isModerator: false,
  isApprover: false,
  eligible: true,
  hasIdentity: true,
  identityKey: null,
  generation: 1,
  safetyNumberChanged: false
})

describe('the chat list’s grouping', function () {
  it('orders pinned DMs, pinned groups, other DMs and other groups by posts without unread priority', function () {
    const preferences = {
      pinned: true,
      muted: false,
      manualUnread: false,
      manualUnreadRevision: 0
    }
    const items = [
      chat({
        id: 'p-group-old',
        preferences,
        kind: 'teamStaff',
        lastPostAt: '2027-04-01T10:00:00Z'
      }),
      chat({
        id: 'p-dm',
        preferences,
        kind: 'dm',
        scope: null,
        lastPostAt: '2027-03-01T10:00:00Z'
      }),
      chat({
        id: 'group-new',
        kind: 'leagueOrg',
        scope: { type: 'league', id: 'lea_test' },
        lastPostAt: '2027-04-05T10:00:00Z'
      }),
      chat({
        id: 'dm-unread',
        kind: 'dm',
        scope: null,
        unread: 8,
        lastPostAt: '2027-04-01T10:00:00Z'
      }),
      chat({
        id: 'p-group-new',
        preferences,
        kind: 'seasonAllStaff',
        scope: { type: 'season', id: 'sea_test' },
        lastPostAt: '2027-04-03T10:00:00Z'
      }),
      chat({
        id: 'dm-read',
        kind: 'dm',
        scope: null,
        lastPostAt: '2027-04-02T10:00:00Z'
      }),
      chat({
        id: 'group-empty',
        lastPostAt: null,
        unread: 99,
        lastMessageAt: '2028-01-01T00:00:00Z'
      }),
      chat({
        id: 'group-tie-b',
        kind: 'teamFans',
        lastPostAt: '2027-04-04T10:00:00Z'
      }),
      chat({
        id: 'group-tie-a',
        kind: 'teamMembers',
        lastPostAt: '2027-04-04T10:00:00Z'
      })
    ]
    const groups = groupChats(items)
    expect(groups.map(group => group.title)).deep.equals(['Pinned', 'Chats'])
    expect(
      groups.flatMap(group => group.chats.map(item => item.id))
    ).deep.equals([
      'p-dm',
      'p-group-new',
      'p-group-old',
      'dm-read',
      'dm-unread',
      'group-new',
      'group-tie-a',
      'group-tie-b',
      'group-empty'
    ])
    expect(items[0].id).equals('p-group-old')
    expect(groupChats([])).deep.equals([])
    expect(groupChats([chat()]).map(group => group.title)).deep.equals([
      'Chats'
    ])
    expect(
      groupChats([chat({ preferences })]).map(group => group.title)
    ).deep.equals(['Pinned'])
    expect(
      groupChats([chat({ id: 'same' }), chat({ id: 'same' })])[0].chats
    ).has.length(2)
  })

  it('offers New message only to someone who shares a staff or members chat', function () {
    expect(canStartDm([])).equals(false)
    expect(canStartDm([chat({ kind: 'teamFans' })])).equals(false)
    expect(
      canStartDm([
        chat({ kind: 'teamFans' }),
        chat({ kind: 'dm', scope: null }),
        chat({ kind: 'seasonAnnouncements' })
      ])
    ).equals(false)
    for (const kind of [
      'teamStaff',
      'teamMembers',
      'seasonStaff',
      'seasonAllStaff',
      'leagueOrg'
    ] as const) {
      expect(canStartDm([chat({ kind })]), kind).equals(true)
    }
  })

  it('dots the tab only while something is unread', function () {
    expect(hasUnread([chat(), chat({ unread: 0 })])).equals(false)
    expect(hasUnread([chat(), chat({ unread: 2 })])).equals(true)
  })
})

describe('read ticks', function () {
  const members = [
    member(userIdOfGumbo(1), 'Hank C'),
    member(userIdOfGumbo(2), 'Blair B'),
    member(userIdOfGumbo(3), 'Casey C')
  ]

  it('says Sent before anyone has read it', function () {
    expect(
      readLine(message({ mine: true }), chat(), members, 'Former')
    ).deep.equals({ kind: 'sent' })
  })

  it('names who has read it in a chat of up to 20, and in a DM', function () {
    const read = message({
      mine: true,
      readBy: [userIdOfGumbo(2), userIdOfGumbo(3), userIdOfGumbo(9)]
    })
    expect(
      readLine(read, chat({ memberCount: 20 }), members, 'Former member')
    ).deep.equals({
      kind: 'names',
      names: ['Blair B', 'Casey C', 'Former member']
    })
    expect(
      readLine(read, chat({ kind: 'dm', memberCount: 25 }), members, 'F')
    ).deep.equals({ kind: 'names', names: ['Blair B', 'Casey C', 'F'] })
  })

  it('counts them above 20 members', function () {
    expect(
      readLine(
        message({ mine: true, readBy: [userIdOfGumbo(2), userIdOfGumbo(3)] }),
        chat({ memberCount: 21 }),
        members,
        'F'
      )
    ).deep.equals({ kind: 'count', count: 2 })
  })
})

describe('what a long press offers', function () {
  const view = (
    composer: 'enabled' | 'locked' | 'readOnly' | 'closed',
    canModerate = false
  ): Parameters<typeof actionsFor>[1] => ({
    composer,
    conversation: chat({ canModerate })
  })

  it('offers reply, react, copy, personal pin and delete on one’s own message', function () {
    expect(actionsFor(message({ mine: true }), view('enabled'))).deep.equals([
      'reply',
      'react',
      'copy',
      'pin',
      'delete'
    ])
  })

  it('offers moderator deletion and personal actions on received messages', function () {
    expect(actionsFor(message(), view('enabled', true))).deep.equals([
      'reply',
      'react',
      'copy',
      'pin',
      'deleteForEveryone'
    ])
    expect(actionsFor(message(), view('enabled'))).deep.equals([
      'reply',
      'react',
      'copy',
      'pin'
    ])
  })

  it('lets an Announcements reader react, copy and pin', function () {
    expect(actionsFor(message(), view('readOnly'))).deep.equals([
      'react',
      'copy',
      'pin'
    ])
    expect(actionsFor(message({ mine: true }), view('readOnly'))).deep.equals([
      'react',
      'copy',
      'pin'
    ])
  })

  it('retains personal actions on readable posts in closed or locked chats', function () {
    expect(actionsFor(message(), view('closed', true))).deep.equals([
      'copy',
      'pin'
    ])
    expect(actionsFor(message(), view('locked'))).deep.equals(['copy', 'pin'])
    expect(actionsFor(message({ mine: true }), view('closed'))).deep.equals([
      'copy',
      'pin'
    ])
  })

  it('allows lost or invalid cleanup while hiding deletion of locked or removed content', function () {
    expect(
      actionsFor(message({ status: 'locked', mine: true }), view('enabled'))
    ).deep.equals([])
    expect(
      actionsFor(message({ status: 'invalid' }), view('enabled', true))
    ).deep.equals(['deleteForEveryone'])
    expect(
      actionsFor(message({ status: 'lost' }), view('enabled'))
    ).deep.equals([])
    expect(
      actionsFor(message({ status: 'lost' }), view('locked', true))
    ).deep.equals([])
    expect(
      actionsFor(message({ status: 'removed', mine: true }), view('enabled'))
    ).deep.equals([])
  })
})

describe('the small words of the chat screens', function () {
  it('names who is typing, and somebody it cannot name', function () {
    expect(
      typingNames([{ name: 'Blair B' }, { name: undefined }], 'Someone')
    ).deep.equals(['Blair B', 'Someone'])
  })

  it('says when, by how long ago', function () {
    const now = new Date(2027, 3, 8, 15, 0)
    expect(timeLabel(null, now)).equals('')
    expect(timeLabel(new Date(2027, 3, 8, 9, 5).toISOString(), now)).equals(
      '9:05 AM'
    )
    expect(timeLabel(new Date(2027, 3, 6, 9, 5).toISOString(), now)).equals(
      'Tue'
    )
    expect(timeLabel(new Date(2027, 2, 1, 9, 5).toISOString(), now)).equals(
      'Mar 1'
    )
  })

  it('reads sizes as people do', function () {
    expect(sizeLabel(812)).equals('812 B')
    expect(sizeLabel(48209)).equals('47 KB')
    expect(sizeLabel(20526514)).equals('19.6 MB')
  })

  it('sizes a placeholder from the picture, never larger than it is', function () {
    expect(placeholderSize(1280, 960, 320, 400)).deep.equals({
      width: 320,
      height: 240
    })
    expect(placeholderSize(600, 2000, 320, 400)).deep.equals({
      width: 120,
      height: 400
    })
    expect(placeholderSize(100, 50, 320, 400)).deep.equals({
      width: 100,
      height: 50
    })
    expect(placeholderSize(undefined, 50, 320, 400)).deep.equals({
      width: 320,
      height: 240
    })
    expect(placeholderSize(0, 0, 320, 400)).deep.equals({
      width: 320,
      height: 240
    })
  })

  it('shows a safety number as 12 groups of five', function () {
    const digits = '0123456789'.repeat(6)
    const groups = safetyGroups(digits)
    expect(groups).length(12)
    expect(groups.every(group => /^\d{5}$/.test(group))).equals(true)
    expect(groups.join('')).equals(digits)
  })

  it('replies to a drag of 60 points to the right, and follows it a little', function () {
    expect(swipeOffset(-20)).equals(0)
    expect(swipeOffset(40)).equals(40)
    expect(swipeOffset(500)).equals(90)
    expect(swipeReplies(59)).equals(false)
    expect(swipeReplies(60)).equals(true)
  })

  it('names files safely and guesses their type', function () {
    expect(safeFileName('My Photo (1).JPG')).equals('My_Photo_1_.JPG')
    expect(safeFileName('...')).equals('file')
    expect(safeFileName('a'.repeat(200))).length(120)
    expect(contentTypeOf('x.jpg')).equals('image/jpeg')
    expect(contentTypeOf('x.JPEG')).equals('image/jpeg')
    expect(contentTypeOf('x.png')).equals('image/png')
    expect(contentTypeOf('x.gif')).equals('image/gif')
    expect(contentTypeOf('x.heic')).equals('image/heic')
    expect(contentTypeOf('x.mp4')).equals('video/mp4')
    expect(contentTypeOf('x.mov')).equals('video/quicktime')
    expect(contentTypeOf('x.pdf')).equals('application/pdf')
    expect(contentTypeOf('x')).equals('application/octet-stream')
    expect(contentTypeOf('x.jpg', 'image/webp')).equals('image/webp')
    expect(contentTypeOf('x.jpg', '')).equals('image/jpeg')
  })
})

describe('approvals', function () {
  const asking = (
    requestId: number,
    conversationId: string,
    userId: string
  ): GrantApproval => ({
    requestId,
    conversationId,
    conversationTitle: undefined,
    userId,
    name: undefined,
    oldSafetyNumber: undefined,
    newSafetyNumber: '1'.repeat(60)
  })

  it('lists one chat’s, never the person’s own', function () {
    const all = [
      asking(1, 'cnv_a', userIdOfGumbo(7)),
      asking(2, 'cnv_a', userIdOfGumbo(3)),
      asking(3, 'cnv_b', userIdOfGumbo(7))
    ]
    expect(
      approvalsIn(all, 'cnv_a', userIdOfGumbo(3)).map(one => one.requestId)
    ).deep.equals([1])
    expect(
      approvalsIn(all, 'cnv_b', userIdOfGumbo(3)).map(one => one.requestId)
    ).deep.equals([3])
    expect(approvalsIn(all, 'cnv_b', userIdOfGumbo(7))).deep.equals([])
  })
})
