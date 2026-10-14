import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { asChatDmPerson } from '../../common/api'
import { ThemeProvider } from '../theme/ThemeContext'
import { ChatAvatar } from './ChatAvatar'
import { conversationIdentity } from './chatIdentityModel'
import { ChatListScreen } from './ChatListScreen'
import { chat } from './chatViews.test.helpers'
import type { ConversationListItem } from './engine/engine'

let root: Root | undefined
let host: HTMLElement | undefined
const originalImage = window.Image

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
  window.Image = originalImage
})

async function render(element: React.ReactElement): Promise<HTMLElement> {
  if (root == null) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
    await new Promise(resolve => setTimeout(resolve, 20))
  })
  return host!
}

describe('chat identity presentation', function () {
  it('draws shared rounded tiles and a deterministic composite for several current participants', async function () {
    for (const count of [1, 2, 3, 5]) {
      const people = Array.from({ length: count }, (_, index) =>
        asChatDmPerson({
          userId: index + 1,
          shortName: index % 2 === 0 ? 'Aaron Judge' : 'Mookie Betts',
          left: false
        })
      )
      const identity = conversationIdentity(
        chat({ kind: 'dm', scope: null, people })
      )
      const node = await render(<ChatAvatar identity={identity} size={3} />)
      const avatar = node.querySelector<HTMLElement>(
        '[data-testid="chat-avatar"]'
      )!
      expect(avatar.style.width).equals('48px')
      expect(avatar.style.height).equals('48px')
      expect(getComputedStyle(avatar).overflowX).equals('hidden')
      expect(getComputedStyle(avatar).overflowY).equals('hidden')
      expect(avatar.getAttribute('aria-label')).equals(identity.label)
      expect(avatar.children.length).equals(Math.min(count, 4))
      const tile = avatar.firstElementChild!.firstElementChild as HTMLElement
      expect(tile.style.borderRadius).not.equals('9999px')
    }
  })

  it('falls back after an expired image and tries a renewed signed URL without navigation', async function () {
    const requests: Array<{
      src: string
      onerror: ((event: unknown) => void) | null
    }> = []
    window.Image = class {
      src = ''
      onerror: ((event: unknown) => void) | null = null
      onload: unknown
      constructor() {
        requests.push(this)
      }
    } as unknown as typeof Image
    const first = chat({
      scopeName: 'Harbor',
      avatarUrl: 'https://media.example.test/old.png'
    })
    await render(<ChatAvatar identity={conversationIdentity(first)} />)
    expect(requests.some(request => request.src === first.avatarUrl)).equals(
      true
    )
    await act(async () => {
      requests.find(request => request.src === first.avatarUrl)!.onerror?.({})
    })
    expect(host!.textContent).contains('HA')
    await render(
      <ChatAvatar
        identity={conversationIdentity({
          ...first,
          avatarUrl: 'https://media.example.test/renewed.png'
        })}
      />
    )
    expect(
      requests.some(request => request.src.endsWith('/renewed.png'))
    ).equals(true)
    expect(host!.textContent).not.contains('HA')
  })

  it('names each row by its title, visible preview and unread state for screen readers', async function () {
    const list: ConversationListItem[] = [
      chat({ id: 'news', lastSeq: 7, preview: 'Bring water', unread: 3 }),
      chat({
        id: 'marked',
        lastSeq: 2,
        preview: 'See you there',
        preferences: {
          pinned: false,
          muted: false,
          manualUnread: true,
          manualUnreadRevision: 1
        }
      }),
      chat({ id: 'quiet', lastSeq: 0 }),
      chat({ id: 'locked', locked: true, preview: 'Private text', unread: 1 })
    ]
    const node = await render(
      <ChatListScreen
        embedded
        narrow={false}
        engine={{
          refresh: async () => list,
          conversations: () => list,
          subscribe: () => () => {}
        }}
        onOpen={() => {}}
        onNewMessage={() => {}}
      />
    )
    const label = (id: string): string | null =>
      node
        .querySelector(`[data-testid="chat-conversation-${id}"]`)!
        .getAttribute('aria-label')
    const title = (id: string): string => list.find(c => c.id === id)!.title
    expect(label('news')).equals(title('news') + ', Bring water, 3 unread')
    expect(label('marked')).equals(
      title('marked') + ', See you there, Marked unread'
    )
    expect(label('quiet')).equals(title('quiet'))
    expect(label('locked')).equals(
      title('locked') + ', Locked message, 1 unread'
    )
  })

  it('uses one pair of row gutters, vertical overflow targets, text-inset separators and blank empty previews', async function () {
    const list: ConversationListItem[] = [
      chat({ id: 'empty', scopeName: 'Harbor', lastSeq: 0 }),
      chat({
        id: 'operations',
        scopeName: 'Orchard',
        lastSeq: 4,
        lastPostSeq: 0
      }),
      chat({ id: 'loading', lastSeq: 4 }),
      chat({ id: 'failed', lastSeq: 5, previewFailed: true }),
      chat({ id: 'locked', locked: true, preview: 'Private text' })
    ]
    const opened: string[] = []
    const node = await render(
      <ChatListScreen
        embedded
        narrow={false}
        engine={{
          refresh: async () => list,
          conversations: () => list,
          subscribe: () => () => {}
        }}
        onOpen={item => {
          opened.push(item.id)
        }}
        onNewMessage={() => {}}
      />
    )
    expect(node.textContent)
      .not.contains('No messages yet')
      .and.not.contains('Follow a team')
      .and.not.contains('Private text')
    expect(node.textContent)
      .contains('Loading latest message')
      .and.contains('Locked message')
    expect(
      node.querySelectorAll('[data-testid="chat-row-separator"]').length
    ).equals(list.length - 1)
    const buttons = [
      ...node.querySelectorAll<HTMLElement>(
        '[aria-label^="Conversation actions:"]'
      )
    ]
    expect(buttons.length).equals(list.length)
    for (const button of buttons) {
      expect(Number.parseFloat(getComputedStyle(button).minHeight)).at.least(44)
      expect(Number.parseFloat(getComputedStyle(button).minWidth)).at.least(44)
      const dots = button.firstElementChild as HTMLElement
      expect(dots.children.length).equals(3)
      expect(getComputedStyle(dots).gap).not.equals('')
    }
    const row = node.querySelector<HTMLElement>(
      '[data-testid="chat-conversation-empty"]'
    )!
    const container = row.parentElement!
    expect(Number.parseFloat(container.style.paddingLeft)).at.least(16)
    expect(row.style.paddingLeft).equals('')
    await act(async () => {
      row.click()
    })
    expect(opened).deep.equals(['empty'])
    await act(async () => {
      buttons[0].click()
    })
    const menu = node.querySelector('[aria-label="Conversation actions"]')!
    expect(menu).not.equals(null)
    expect(
      [...menu.querySelectorAll('[role="button"],button')].some(
        control => control.textContent?.trim() === 'Pin'
      )
    ).equals(true)
  })
})
