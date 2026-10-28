import { expect } from 'chai'
import { describe, it } from 'mocha'

import { MAX_BODY } from '../../common/chatContent'
import { userIdOfGumbo } from '../../common/userId'
import {
  insertMention,
  mentionIds,
  mentionRequest,
  type MentionToken,
  reconcileMentions,
  sameMentionTokens,
  textEdit,
  validMentionTokens
} from './chatMentionsModel'
import { member, message } from './chatViews.test.helpers'
import {
  ChatDraftOwner,
  emptyChatDraft,
  newChatWorkspaceState
} from './chatWorkspaceModel'

const text = 'Hi @Aaron Judge ready'
const token: MentionToken = {
  userId: userIdOfGumbo(2),
  start: 3,
  end: 15,
  label: '@Aaron Judge'
}

describe('local mention ranges', function () {
  it('opens only a newly typed eligible @ and leaves bare text, emails and paste as ordinary text', function () {
    expect(mentionRequest('', '@')).deep.equals({ text: '@', start: 0, end: 1 })
    expect(mentionRequest('Hi ', 'Hi @')?.start).equals(3)
    expect(mentionRequest('(', '(@')?.start).equals(1)
    expect(mentionRequest('@@ ', '@@@ ')).equals(undefined)
    expect(
      mentionRequest('@@ ', '@@@ ', { selection: { start: 0, end: 0 } })?.start
    ).equals(0)
    for (const [before, after] of [
      ['mail', 'mail@'],
      ['', '@Aaron Judge'],
      ['@', '@@'],
      ['Hi', 'Hi!'],
      ['Hi @', 'Hi @A']
    ])
      expect(mentionRequest(before, after)).equals(undefined)
  })

  it('inserts a stable member ID at the requested caret, adds a separator, and preserves text around it', function () {
    const person = member(userIdOfGumbo(2), 'Aaron Judge')
    const request = mentionRequest('Hi  ready', 'Hi @ ready')!
    const next = insertMention(request, request.text, undefined, person)!
    expect(next.text).equals(text)
    expect(next.tokens).deep.equals([token])
    expect(next.selection).deep.equals({ start: 16, end: 16 })
    const end = insertMention(mentionRequest('', '@')!, '@', [], person)!
    expect(end.text).equals('@Aaron Judge ')
    expect(end.selection.start).equals(13)
    expect(insertMention(request, 'Changed draft', [], person)).equals(
      undefined
    )
    expect(
      insertMention({ text: 'x', start: 0, end: 1 }, 'x', [], person)
    ).equals(undefined)
  })

  it('moves ranges across caret edits, emoji and paste without linking arbitrary matching text', function () {
    expect(reconcileMentions(text, '🙂 ' + text, [token])[0]).includes({
      start: 6,
      end: 18
    })
    expect(reconcileMentions(text, 'Paste ' + text, [token])[0]).includes({
      start: 9,
      end: 21
    })
    expect(reconcileMentions(text, text + ' now', [token])).deep.equals([token])
    expect(reconcileMentions(text, text, [token])).deep.equals([token])
    expect(
      reconcileMentions(text, text.replace('Aaron', 'Aaroon'), [token])
    ).deep.equals([])
    expect(
      reconcileMentions(text, text.replace('@Aaron Judge', ''), [token])
    ).deep.equals([])
    expect(
      reconcileMentions(
        'Hi @AA ',
        'Hi @AAA ',
        [{ userId: userIdOfGumbo(2), start: 3, end: 6, label: '@AA' }],
        { selection: { start: 5, end: 5 } }
      )
    ).deep.equals([])
    expect(
      reconcileMentions('Hi @AA ', 'Hi @AAA ', [
        { userId: userIdOfGumbo(2), start: 3, end: 6, label: '@AA' }
      ])
    ).deep.equals([])
    expect(mentionIds('Hi @Aaron Judge', undefined, [person()])).deep.equals([])
    function person(): ReturnType<typeof member> {
      return member(userIdOfGumbo(2), 'Aaron Judge')
    }
  })

  it('tracks repeated characters with native/web selection hints, including forward delete and backspace', function () {
    expect(
      textEdit('aaaa', 'aaa', {
        selection: { start: 2, end: 2 },
        key: 'Backspace'
      })
    ).deep.equals({ start: 1, beforeEnd: 2, afterEnd: 1 })
    expect(
      textEdit('aaaa', 'aaa', {
        selection: { start: 2, end: 2 },
        key: 'Delete'
      })
    ).deep.equals({ start: 2, beforeEnd: 3, afterEnd: 2 })
    expect(
      textEdit('aaaa', 'aaa', { selection: { start: 2, end: 2 } })
    ).deep.equals({ start: 1, beforeEnd: 3, afterEnd: 2 })
    expect(
      textEdit('abc', 'aXYc', { selection: { start: 1, end: 2 } })
    ).deep.equals({ start: 1, beforeEnd: 2, afterEnd: 3 })
    expect(textEdit('🙂x', '🙃x')).deep.equals({
      start: 0,
      beforeEnd: 2,
      afterEnd: 2
    })
    expect(
      textEdit('abc', 'zabc', { selection: { start: 100, end: 100 } }).start
    ).equals(0)
  })

  it('refuses malformed or split-surrogate tokens and enforces the existing Unicode body limit', function () {
    expect(validMentionTokens(text, [token])).deep.equals([token])
    for (const bad of [
      { ...token, userId: 0 as unknown as string },
      { ...token, start: -1 },
      { ...token, end: 100 },
      { ...token, end: 3 },
      { ...token, label: 'Aaron Judge' },
      { ...token, start: 0.5 }
    ])
      expect(validMentionTokens(text, [bad])).deep.equals([])
    expect(
      validMentionTokens('@🙂 ', [
        { userId: userIdOfGumbo(2), start: 0, end: 2, label: '@\ud83d' }
      ])
    ).deep.equals([])
    const long = '🙂'.repeat(MAX_BODY - 2) + ' @'
    expect(
      insertMention(
        { text: long, start: long.length - 1, end: long.length },
        long,
        [],
        member(userIdOfGumbo(2), 'Aaron Judge')
      )
    ).equals(undefined)
    expect(
      textEdit('🙂x', '🙂y', { selection: { start: 1, end: 1 } }).start
    ).equals(2)
  })

  it('deduplicates selected IDs, keeps renamed labels readable and drops departed members without deleting text', function () {
    const twice = '@Aaron Judge @Aaron Judge '
    const tokens = [
      { ...token, start: 0, end: 12 },
      { ...token, start: 13, end: 25 }
    ]
    expect(
      mentionIds(twice, tokens, [member(userIdOfGumbo(2), 'Renamed Member')])
    ).deep.equals([userIdOfGumbo(2)])
    expect(mentionIds(twice, tokens, [])).deep.equals([])
    const duplicateNames = [
      { ...tokens[0], userId: userIdOfGumbo(2) },
      { ...tokens[1], userId: userIdOfGumbo(3) }
    ]
    expect(
      mentionIds(twice, duplicateNames, [
        member(userIdOfGumbo(2), 'Aaron Judge'),
        member(userIdOfGumbo(3), 'Aaron Judge')
      ])
    ).deep.equals([userIdOfGumbo(2), userIdOfGumbo(3)])
    expect(
      validMentionTokens(text, [token, { ...token, userId: userIdOfGumbo(3) }])
    ).deep.equals([])
    expect(twice).equals('@Aaron Judge @Aaron Judge ')
    const legacy = message({
      body: '@Aaron Judge',
      mentions: [userIdOfGumbo(2), userIdOfGumbo(2), userIdOfGumbo(3)]
    })
    expect(
      mentionIds(
        legacy.body,
        undefined,
        [member(userIdOfGumbo(2), 'Aaron Judge')],
        legacy
      )
    ).deep.equals([userIdOfGumbo(2)])
    expect(
      mentionIds(
        legacy.body + ' changed',
        undefined,
        [member(userIdOfGumbo(2), 'Aaron Judge')],
        legacy
      )
    ).deep.equals([])
    expect(
      mentionIds(
        legacy.body,
        [],
        [member(userIdOfGumbo(2), 'Aaron Judge')],
        legacy
      )
    ).deep.equals([])
  })
})

describe('mention draft ownership', function () {
  it('includes token identity in revisions even when the readable draft text is identical', function () {
    const state = newChatWorkspaceState()
    const owner = new ChatDraftOwner(state)
    owner.write('cnv_1', { ...emptyChatDraft(), text, mentionTokens: [token] })
    const submitted = owner.begin('cnv_1')!
    owner.write('cnv_1', {
      ...owner.draft('cnv_1'),
      mentionTokens: [{ ...token, userId: userIdOfGumbo(3) }]
    })
    owner.finish('cnv_1', submitted, true)
    expect(owner.draft('cnv_1').mentionTokens![0].userId).equals(
      userIdOfGumbo(3)
    )
    expect(owner.draft('cnv_1').text).equals(text)
  })

  it('preserves tokens on failure and clears only the submitted unchanged version on success', function () {
    const owner = new ChatDraftOwner(newChatWorkspaceState())
    owner.write('cnv_1', { ...emptyChatDraft(), text, mentionTokens: [token] })
    const failed = owner.begin('cnv_1')!
    owner.finish('cnv_1', failed, false)
    expect(owner.failed('cnv_1')).equals(true)
    expect(owner.draft('cnv_1').mentionTokens).deep.equals([token])
    const retry = owner.begin('cnv_1')!
    expect(retry.draft.mentionTokens![0]).not.equals(token)
    owner.finish('cnv_1', retry, true)
    expect(owner.draft('cnv_1').text).equals('')
    expect(owner.draft('cnv_1').mentionTokens).deep.equals([])
    expect(sameMentionTokens(undefined, undefined)).equals(true)
    expect(sameMentionTokens(undefined, [])).equals(false)
    expect(sameMentionTokens([token], [token])).equals(true)
    expect(sameMentionTokens([token], [])).equals(false)
    expect(sameMentionTokens([token], [{ ...token, end: 14 }])).equals(false)
    owner.invalidate()
    expect(owner.finish('cnv_1', retry, true)).equals(undefined)
  })
})
