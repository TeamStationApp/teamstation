import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ChatBlock } from '../../common/api'
import type { ChatSocketListener } from '../../common/gameSocket'
import { userIdOfGumbo } from '../../common/userId'
import { rowTextColor } from '../../test/gameFormDom'
import { ScopedThemeProvider, ThemeProvider } from '../theme/ThemeContext'
import { tsDark } from '../theme/tsDark'
import { BlockedPeople } from './BlockedPeople'
import {
  ChatBlockConfirmation,
  type ChatSafetyAction
} from './ChatBlockConfirmation'
import { ChatOverlayHost } from './ChatOverlayHost'
import { measureChatTestViewport, message } from './chatViews.test.helpers'
import { MessageMenu } from './MessageMenu'
import { SafetyNumberScreen } from './SafetyNumberScreen'

let root: Root | undefined
let host: HTMLDivElement
let restore: (() => void) | undefined
const wait = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 25))
}
async function render(node: React.ReactNode): Promise<void> {
  if (root == null) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    restore = measureChatTestViewport()
  }
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <ChatOverlayHost>{node}</ChatOverlayHost>
      </ThemeProvider>
    )
    await wait()
  })
  await act(async () => {
    await wait()
  })
}
function button(label: string): HTMLElement {
  const found = [
    ...document.querySelectorAll<HTMLElement>('[role="button"],button')
  ].find(
    node =>
      node.closest('[aria-hidden="true"]') == null &&
      (node.getAttribute('aria-label') === label ||
        node.textContent?.trim() === label)
  )
  expect(found, label).not.equals(undefined)
  return found!
}
async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click()
    await wait()
  })
}

const person: ChatBlock = {
  userId: userIdOfGumbo(2),
  userIds: [userIdOfGumbo(2)],
  shortName: 'Fixture Peer',
  avatarUrl: null,
  createdAt: '2027-01-01T00:00:00Z'
}

describe('block and report controls', () => {
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    host?.remove()
    restore?.()
  })
  it('explains privacy and preserves cancellation, retry, and duplicate protection', async () => {
    let writes = 0
    let closes = 0
    let success = 0
    let release!: () => void
    const work = async (): Promise<void> => {
      writes++
      if (writes === 1) throw new Error('offline')
      await new Promise<void>(resolve => {
        release = resolve
      })
    }
    const node = (
      <ChatBlockConfirmation
        name="Fixture Peer"
        action="block"
        onConfirm={work}
        onClose={() => {
          closes++
        }}
        onSuccess={() => {
          success++
        }}
      />
    )
    await render(node)
    expect(document.body.textContent).contains('They will not be notified')
    await click('Cancel')
    expect(writes).equals(0)
    expect(closes).equals(1)
    await render(React.cloneElement(node, { key: 'retry' }))
    await click('Block')
    expect(document.body.textContent).contains('Check your connection')
    await click('Block')
    await click('Block')
    await click('Cancel')
    expect(writes).equals(2)
    expect(closes).equals(1)
    await act(async () => {
      release()
      await wait()
    })
    expect(success).equals(1)
    expect(closes).equals(2)
  })
  it('ignores a completed write after its owning screen leaves', async () => {
    let release!: () => void
    let closed = false
    await render(
      <ChatBlockConfirmation
        name="Fixture Peer"
        action="unblock"
        onConfirm={async () => {
          await new Promise<void>(resolve => {
            release = resolve
          })
        }}
        onClose={() => {
          closed = true
        }}
      />
    )
    await click('Unblock')
    await render(null)
    await act(async () => {
      release()
      await wait()
    })
    expect(closed).equals(false)
  })
  for (const action of ['report', 'reportAndBlock'] as const)
    it(`confirms ${action} with the report disclosure`, async () => {
      let sent = false
      await render(
        <ChatBlockConfirmation
          name="Fixture Peer"
          action={action}
          onConfirm={async () => {
            sent = true
          }}
          onClose={() => {}}
        />
      )
      expect(document.body.textContent).contains(
        'Nothing else in this chat is shared'
      )
      await click(action === 'report' ? 'Report message' : 'Report and Block')
      expect(sent).equals(true)
    })
  it('offers all three message entrypoints and hands off after closing', async () => {
    const actions: ChatSafetyAction[] = []
    const anchor = document.createElement('button')
    document.body.append(anchor)
    anchor.getBoundingClientRect = () => ({
      x: 20,
      y: 100,
      left: 20,
      top: 100,
      right: 60,
      bottom: 140,
      width: 40,
      height: 40,
      toJSON: () => ({})
    })
    for (const [action, label] of [
      ['report', 'Report'],
      ['block', 'Block'],
      ['reportAndBlock', 'Report and Block']
    ] as const) {
      await render(
        <MessageMenu
          key={action}
          desktop
          anchor={anchor}
          message={message()}
          actions={[action]}
          onReply={() => {}}
          onReact={() => {}}
          onMoreEmoji={() => {}}
          onDelete={() => {}}
          onClose={() => {}}
          onSafetyAction={next => {
            actions.push(next)
          }}
        />
      )
      await click(label)
    }
    expect(actions).deep.equals(['report', 'block', 'reportAndBlock'])
  })
  it('keeps the confirmed profile action when a successful write is followed by a failed refresh', async () => {
    let blocked = false
    const writes: boolean[] = []
    const engine = {
      safetyNumber: async () => undefined,
      isBlocked: () => blocked,
      setBlocked: async (_id: string, value: boolean) => {
        writes.push(value)
        blocked = value
        if (writes.length === 1) throw new Error('Refresh failed')
      }
    }
    const node = (
      <SafetyNumberScreen
        engine={engine}
        userId={person.userId}
        name={person.shortName}
        onDone={() => {}}
      />
    )
    await render(node)
    await click('Block Fixture Peer')
    await click('Block')
    await render(React.cloneElement(node))
    expect(document.body.textContent).contains('Check your connection')
    await click('Block')
    expect(writes).deep.equals([true, true])
  })
  it('loads Account blocks without keys, retries, confirms unblock, and shows the empty state', async () => {
    let reads = 0
    let writes = 0
    let done = false
    const client = {
      chatBlocks: async (): Promise<ChatBlock[]> => {
        if (++reads === 1) throw new Error('offline')
        return [person]
      },
      setChatBlock: async (
        id: string,
        value: boolean
      ): Promise<ChatBlock[]> => {
        expect(id).equals(person.userId)
        expect(value).equals(false)
        writes++
        return []
      }
    }
    await render(
      <BlockedPeople
        client={client}
        onClose={() => {
          done = true
        }}
      />
    )
    await click('Try again')
    expect(document.body.textContent).contains(person.shortName)
    await click('Unblock Fixture Peer')
    expect(writes).equals(0)
    await click('Cancel')
    expect(writes).equals(0)
    await click('Unblock Fixture Peer')
    await click('Unblock')
    expect(writes).equals(1)
    expect(document.body.textContent).contains('You have not blocked anyone')
    await click('Done')
    expect(done).equals(true)
  })
  it('refreshes the open Account list on personal hints and reconnect, ignoring older reads', async () => {
    let listener!: ChatSocketListener
    let unsubscribed = false
    const pending: Array<(rows: ChatBlock[]) => void> = []
    const client = {
      chatBlocks: async (): Promise<ChatBlock[]> =>
        await new Promise(resolve => pending.push(resolve)),
      setChatBlock: async (): Promise<ChatBlock[]> => []
    }
    const socket = {
      onChat: (next: ChatSocketListener) => {
        listener = next
        return () => {
          unsubscribed = true
        }
      }
    }
    await render(
      <BlockedPeople client={client} socket={socket} onClose={() => {}} />
    )
    await act(async () => {
      listener({ type: 'chatUser', kind: 'blocks' })
      pending[1]([person])
      await wait()
      pending[0]([])
      await wait()
    })
    expect(document.body.textContent).contains(person.shortName)
    listener({
      type: 'chatTyping',
      conversationId: 'fixture',
      userId: person.userId
    })
    expect(pending).has.length(2)
    await click('Unblock Fixture Peer')
    await act(async () => {
      listener({ type: 'resync' })
      pending[2]([])
      await wait()
    })
    expect(document.body.textContent).contains('You have not blocked anyone')
    expect(
      document.querySelector('[data-testid="chat-safety-confirm"]')
    ).equals(null)
    await render(<></>)
    expect(unsubscribed).equals(true)
  })
  it('does not let a concurrent list read undo a successful Account unblock', async () => {
    let listener!: ChatSocketListener
    let reads = 0
    let stale!: (rows: ChatBlock[]) => void
    let finish!: (rows: ChatBlock[]) => void
    const client = {
      chatBlocks: async (): Promise<ChatBlock[]> => {
        if (++reads === 1) return [person]
        if (reads === 2)
          return await new Promise(resolve => {
            stale = resolve
          })
        return []
      },
      setChatBlock: async (): Promise<ChatBlock[]> =>
        await new Promise(resolve => {
          finish = resolve
        })
    }
    const socket = {
      onChat: (next: ChatSocketListener) => {
        listener = next
        return () => {}
      }
    }
    await render(
      <BlockedPeople client={client} socket={socket} onClose={() => {}} />
    )
    await click('Unblock Fixture Peer')
    await click('Unblock')
    await act(async () => {
      listener({ type: 'chatUser', kind: 'blocks' })
      finish([])
      await wait()
    })
    await act(async () => {
      stale([person])
      await wait()
    })
    expect(reads).equals(3)
    expect(document.body.textContent).contains('You have not blocked anyone')
    expect(document.body.textContent).not.contains(person.shortName)
  })
  it('keeps blocked people and the profile row readable on a dark card', async () => {
    await render(
      <ScopedThemeProvider theme={tsDark}>
        <BlockedPeople
          client={{
            chatBlocks: async () => [person],
            setChatBlock: async () => []
          }}
          onClose={() => {}}
        />
      </ScopedThemeProvider>
    )
    expect(rowTextColor(person.shortName)).equals('rgb(31, 36, 24)')
    await render(
      <ScopedThemeProvider theme={tsDark}>
        <SafetyNumberScreen
          engine={{
            safetyNumber: async () => undefined,
            isBlocked: () => false,
            setBlocked: async () => {}
          }}
          userId={person.userId}
          name={person.shortName}
          onDone={() => {}}
        />
      </ScopedThemeProvider>
    )
    expect(rowTextColor(person.shortName)).equals('rgb(31, 36, 24)')
    expect(button('Block Fixture Peer')).not.equals(undefined)
  })
  it('offers block and unblock from the chat person profile', async () => {
    let blocked = false
    const engine = {
      safetyNumber: async () => undefined,
      isBlocked: () => blocked,
      setBlocked: async (_id: string, value: boolean) => {
        blocked = value
      }
    }
    await render(
      <SafetyNumberScreen
        engine={engine}
        userId={person.userId}
        name={person.shortName}
        onDone={() => {}}
      />
    )
    await click('Block Fixture Peer')
    await click('Block')
    expect(blocked).equals(true)
    await click('Unblock Fixture Peer')
    await click('Unblock')
    expect(blocked).equals(false)
  })
})
