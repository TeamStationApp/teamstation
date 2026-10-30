import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import {
  newDeviceKeys,
  newIdentityKey,
  newPukKey
} from '../../common/chatCrypto/keys'
import { newIdentityId } from '../../common/chatCrypto/messageIds'
import { userIdOfGumbo } from '../../common/userId'
import { ThemeProvider } from '../theme/ThemeContext'
import { ChatLinks } from './ChatLinks'
import type { ChatEngine, ConversationListItem } from './engine/engine'
import { entityChats, entityPreviewLoader } from './entityChats'
import { type ChatKeyRecord, newRecord } from './keyRecord'

const me = userIdOfGumbo(1)
function savedRecord(): ChatKeyRecord {
  const record = newRecord(me, 'cdv_demo', newDeviceKeys())
  record.identity = { id: newIdentityId(), keys: newIdentityKey() }
  record.puks = [{ generation: 1, keys: newPukKey() }]
  return record
}

const item = (
  extra: Partial<ConversationListItem> = {}
): ConversationListItem => ({
  id: 'cnv_staff',
  kind: 'teamStaff',
  title: 'Demo Staff',
  scope: { type: 'team', id: 'group_demo' },
  scopeName: 'Demo',
  lastSeq: 1,
  lastMessageAt: null,
  unread: 1,
  canPost: true,
  canModerate: false,
  locked: false,
  noHolder: false,
  closed: false,
  memberCount: 2,
  unverified: false,
  ...extra
})
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

describe('entity chat scoped rows', () => {
  it('maps every accessible scoped group to its group-only label', () => {
    for (const [kind, type, label] of [
      ['leagueOrg', 'league', 'Org'],
      ['seasonStaff', 'season', 'Staff'],
      ['seasonAllStaff', 'season', 'All Staff'],
      ['seasonAnnouncements', 'season', 'Announcements'],
      ['teamStaff', 'team', 'Staff'],
      ['teamMembers', 'team', 'Members'],
      ['teamFans', 'team', 'Fans']
    ] as const) {
      const chat = item({ kind, scope: { type, id: 'group_demo' } })
      expect(entityChats([chat], { kind: type, id: 'group_demo' })).deep.equals(
        [{ id: chat.id, title: chat.title, label, preview: undefined }]
      )
    }
  })

  it('excludes DMs, unrelated groups and another scope with the same id', () => {
    expect(
      entityChats(
        [
          item({ kind: 'dm', scope: null }),
          item({ scope: { type: 'team', id: 'other' } }),
          item({ scope: { type: 'season', id: 'group_demo' } })
        ],
        { kind: 'team', id: 'group_demo' }
      )
    ).deep.equals([])
  })

  it('shows only nonempty authenticated latest-message previews', () => {
    const group = { kind: 'team', id: 'group_demo' } as const
    for (const extra of [
      {},
      { previewReadable: false },
      { locked: true, previewReadable: true },
      { unverified: true, previewReadable: true },
      { previewFailed: true, previewReadable: true },
      { preview: '', previewReadable: true },
      { preview: '  ', previewReadable: true },
      { preview: undefined, previewReadable: true }
    ])
      expect(
        entityChats(
          [item({ preview: 'Unreadable placeholder', ...extra })],
          group
        )[0].preview
      ).equals(undefined)
    expect(
      entityChats(
        [item({ preview: 'Practice at six', previewReadable: true })],
        group
      )[0].preview
    ).equals('Practice at six')
  })

  it('renders one shared card, chat icons, chevrons and only available subtitles', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    const opened: string[] = []
    const requests: string[][] = []
    const chats = entityChats(
      [
        item({ preview: 'Practice at six', previewReadable: true }),
        item({ id: 'cnv_fans', kind: 'teamFans', locked: true })
      ],
      { kind: 'team', id: 'group_demo' }
    )
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <ChatLinks
            chats={chats}
            onOpen={chat => opened.push(chat.id)}
            onLoadPreview={ids => requests.push(ids)}
          />
        </ThemeProvider>
      )
    })
    expect(
      document.querySelectorAll('[data-testid="entity-chat-list"]')
    ).length(1)
    const rows = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-testid^="entity-chat-cnv"]'
      )
    ]
    expect(rows).length(2)
    expect(rows[0].textContent)
      .contains('Staff')
      .and.contains('Practice at six')
      .and.contains('chat')
      .and.contains('chevron_right')
    expect(rows[1].textContent)
      .contains('Fans')
      .and.not.contains('Practice at six')
    expect(document.body.textContent).not.contains('Demo Staff')
    await act(async () => {
      rows[1].click()
    })
    expect(opened).deep.equals(['cnv_fans'])
    expect(requests).deep.equals([['cnv_staff', 'cnv_fans']])
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <ChatLinks chats={[]} />
        </ThemeProvider>
      )
    })
    expect(document.querySelector('[data-testid="entity-chat-list"]')).equals(
      null
    )
    expect(document.body.textContent).contains('No chats available.')
  })
})

describe('entity chat preview restoration', () => {
  it('restores linked keys once and requests automatic previews without retrying failures', async () => {
    let starts = 0
    const reads: Array<[string, boolean | undefined]> = []
    const engine: Pick<ChatEngine, 'status' | 'start' | 'loadPreview'> = {
      status: 'idle',
      start: async existingOnly => {
        expect(existingOnly).equals(true)
        starts++
        engine.status = 'ready'
        return 'ready' as const
      },
      loadPreview: async (id: string, retry?: boolean) => {
        reads.push([id, retry])
        throw new Error('offline')
      }
    }
    const load = entityPreviewLoader(
      engine,
      {
        load: async () => savedRecord()
      },
      me
    )
    await Promise.all([load(['one']), load(['two'])])
    await load(['one'])
    expect(starts).equals(1)
    expect(reads).deep.equals([
      ['one', false],
      ['two', false],
      ['one', false]
    ])
  })
  it('does not enrol missing, wrong-account, unreadable or unlinked keys', async () => {
    for (const record of [
      undefined,
      { ...savedRecord(), userId: userIdOfGumbo(2) },
      { ...savedRecord(), identity: undefined, puks: [] },
      { ...savedRecord(), puks: [] }
    ]) {
      let starts = 0
      const engine: Pick<ChatEngine, 'status' | 'start' | 'loadPreview'> = {
        status: 'idle',
        start: async () => {
          starts++
          return 'link' as const
        },
        loadPreview: async () => {
          throw new Error('must not load')
        }
      }
      const load = entityPreviewLoader(engine, { load: async () => record }, me)
      await load(['one'])
      await load(['one'])
      expect(starts).equals(0)
    }
    const engine: Pick<ChatEngine, 'status' | 'start' | 'loadPreview'> = {
      status: 'idle',
      start: async () => {
        throw new Error('must not start')
      },
      loadPreview: async () => {
        throw new Error('must not load')
      }
    }
    const load = entityPreviewLoader(
      engine,
      {
        load: async () => {
          throw new Error('unreadable')
        }
      },
      me
    )
    await load(['one'])
    await load(['one'])
    await entityPreviewLoader(
      undefined,
      { load: async () => undefined },
      undefined
    )(['one'])
    await load([])
  })
  it('suppresses previews while linking and after a start failure', async () => {
    let attempts = 0
    const engine: Pick<ChatEngine, 'status' | 'start' | 'loadPreview'> = {
      status: 'idle',
      start: async () => {
        attempts++
        throw new Error('offline')
      },
      loadPreview: async () => {
        throw new Error('must not load')
      }
    }
    const load = entityPreviewLoader(
      engine,
      {
        load: async () => savedRecord()
      },
      me
    )
    await load(['one'])
    await load(['one'])
    expect(attempts).equals(1)
    engine.status = 'link'
    await load(['one'])
  })
})

describe('entity chat unavailable crypto', () => {
  it('leaves titles visible without reading keys when crypto is unavailable', async () => {
    const engine: Pick<ChatEngine, 'status' | 'start' | 'loadPreview'> = {
      status: 'idle',
      start: async () => {
        throw new Error('must not start')
      },
      loadPreview: async () => {
        throw new Error('must not load')
      }
    }
    await entityPreviewLoader(
      engine,
      {
        load: async () => {
          throw new Error('must not read keys')
        }
      },
      me,
      async () => ({ ready: false, reason: 'noWebAssembly' })
    )(['one'])
  })
})
