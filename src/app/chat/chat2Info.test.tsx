import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { userIdOfGumbo, userIdOfValue } from '../../common/userId'
import { HeaderSlotProvider } from '../components/headerSlot'
import { ThemeProvider } from '../theme/ThemeContext'
import { ChatInfoScreen, type ChatInfoScreenProps } from './ChatInfoScreen'
import { chat, member, view } from './chatViews.test.helpers'
import type {
  ConversationListItem,
  ConversationView,
  GrantApproval
} from './engine/engine'
import type { ChatEngineEvent, ChatEngineListener } from './engine/store'

type EngineContract = ChatInfoScreenProps['engine']
class InfoEngine implements EngineContract {
  current: ConversationView | undefined = view({
    conversation: chat({
      scopeName: 'Harbor',
      preferences: {
        pinned: true,
        muted: false,
        manualUnread: true,
        manualUnreadRevision: 7
      }
    }),
    members: [
      member(userIdOfGumbo(1), 'Trea Turner'),
      member(userIdOfGumbo(2), 'Aaron Judge')
    ]
  })

  listeners = new Set<ChatEngineListener>()
  changes: Array<{ id: string; patch: { muted?: boolean } }> = []
  waiting: GrantApproval[] = []
  failOpen = false
  failMute = false
  closed: string[] = []
  view(): ConversationView | undefined {
    return this.current
  }

  async open(): Promise<ConversationView> {
    if (this.failOpen || this.current == null) throw new Error('Unavailable')
    return this.current
  }

  close(id: string): void {
    this.closed.push(id)
  }

  subscribe(listener: ChatEngineListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  emit(event: ChatEngineEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  approvals(): GrantApproval[] {
    return this.waiting
  }

  async approve(): Promise<void> {
    this.waiting = []
    this.emit({ type: 'approvals' })
  }

  async fillGrants(): Promise<number> {
    return 0
  }

  async safetyNumber(_userId: string): Promise<string> {
    return '12345'.repeat(12)
  }

  async refresh(): Promise<ConversationListItem[]> {
    return this.current == null ? [] : [this.current.conversation]
  }

  async setPreferences(id: string, patch: { muted?: boolean }): Promise<void> {
    this.changes.push({ id, patch })
    if (this.failMute || this.current == null) throw new Error('Unavailable')
    this.current = {
      ...this.current,
      conversation: {
        ...this.current.conversation,
        preferences: { ...this.current.conversation.preferences!, ...patch }
      }
    }
    this.emit({ type: 'conversation', conversationId: id })
  }
}

let root: Root | undefined
let host: HTMLElement | undefined
afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
})
async function render(
  engine: InfoEngine,
  over: Partial<ChatInfoScreenProps> = {}
): Promise<HTMLElement> {
  if (root == null) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <ChatInfoScreen
          engine={engine}
          client={{ leaveDm: async () => ({ closed: false }) }}
          userId={userIdOfGumbo(1)}
          conversationId="cnv_1"
          onLeft={() => {}}
          {...over}
        />
      </ThemeProvider>
    )
    await new Promise(resolve => setTimeout(resolve, 30))
  })
  return host!
}
function control(label: string): HTMLElement | null {
  return (
    [...host!.querySelectorAll<HTMLElement>('[role="button"],button')].find(
      button =>
        button.getAttribute('aria-label') === label ||
        (button.getAttribute('aria-label') == null &&
          (button.textContent ?? '').endsWith(label))
    ) ?? null
  )
}

async function press(label: string): Promise<void> {
  const button = control(label)
  expect(button, label).not.equals(null)
  await act(async () => {
    button!.click()
    await new Promise(resolve => setTimeout(resolve, 30))
  })
}

async function pressMember(userId: string): Promise<void> {
  const button = host!.querySelector<HTMLElement>(
    `[data-testid="chat-info-member-${userId}"]`
  )
  expect(button, 'Exact current member row').not.equals(null)
  await act(async () => {
    button!.click()
    await new Promise(resolve => setTimeout(resolve, 30))
  })
}

describe('conversation information', function () {
  it('exposes distinct short-name roles and canonical row identities before opening the exact peer safety digits', async function () {
    const engine = new InfoEngine()
    const coach = userIdOfValue((1n << 127n) + 29n)
    engine.current = view({
      members: [
        member(userIdOfGumbo(1), 'Aaron J', { label: 'Member' }),
        member(userIdOfGumbo(2), 'Aaron J', { label: 'Member' }),
        member(coach, 'Aaron J', { label: 'Coach', isModerator: true }),
        member(userIdOfGumbo(4), 'Mookie Betts', { label: '' })
      ]
    })
    const called: string[] = []
    const digits = '01234'.repeat(12)
    engine.safetyNumber = async id => {
      called.push(id)
      return id === coach ? digits : '98765'.repeat(12)
    }
    const node = await render(engine)
    expect(
      node.querySelectorAll(
        '[role="button"][aria-label="Safety number with Aaron J"]'
      )
    ).has.length(0)
    const row = (id: string): HTMLElement =>
      node.querySelector<HTMLElement>(`[data-testid="chat-info-member-${id}"]`)!
    expect(row(userIdOfGumbo(1)).getAttribute('aria-label')).equals(
      'Aaron J (You), Member'
    )
    expect(row(userIdOfGumbo(1)).getAttribute('aria-disabled')).equals('true')
    expect(row(userIdOfGumbo(2)).getAttribute('aria-label')).equals(
      'Safety number with Aaron J, Member'
    )
    expect(row(coach).getAttribute('aria-label')).equals(
      'Safety number with Aaron J, Coach, Moderator'
    )
    expect(row(userIdOfGumbo(4)).getAttribute('aria-label')).equals(
      'Safety number with Mookie Betts'
    )
    await pressMember(userIdOfGumbo(1))
    expect(called).deep.equals([])
    await pressMember(coach)
    expect(called).deep.equals([coach])
    const groups = [
      ...node.querySelectorAll('[data-testid^="chat-safety-group-"]')
    ]
    expect(groups).has.length(12)
    expect(
      groups.every(group => /^[0-9]{5}$/.test(group.textContent ?? ''))
    ).equals(true)
    expect(groups.map(group => group.textContent).join('')).equals(digits)
  })
  it('shows scope identity, personal mute and rounded current members without fixed-group editing controls', async function () {
    const engine = new InfoEngine()
    const node = await render(engine)
    expect(node.querySelector('[data-testid="chat-info-hero"]')!.textContent)
      .contains('Harbor')
      .and.contains('Team Members')
    expect(node.querySelectorAll('[data-testid="chat-avatar"]').length).equals(
      3
    )
    expect(node.querySelector('[data-testid="chat-info-members"]')!.textContent)
      .contains('2 members')
      .and.contains('Aaron Judge')
    for (const label of [
      'Edit',
      'Chat Color & Wallpaper',
      'All Media',
      'Add Members',
      'Group Link',
      'Member Label',
      'Requests & Invites',
      'Leave this conversation',
      'Block',
      'Report Spam'
    ])
      expect(control(label), label).equals(null)
    await press('Mute')
    expect(engine.changes).deep.equals([
      { id: 'cnv_1', patch: { muted: true } }
    ])
    expect(control('Unmute')).not.equals(null)
    expect(engine.current!.conversation.preferences).includes({
      pinned: true,
      manualUnread: true,
      manualUnreadRevision: 7
    })
    await press('Unmute')
    expect(engine.current!.conversation.preferences!.muted).equals(false)
  })

  it('reflects same-user preference changes and retains a usable mute action after a failure', async function () {
    const engine = new InfoEngine()
    const node = await render(engine)
    await act(async () => {
      engine.current = {
        ...engine.current!,
        conversation: {
          ...engine.current!.conversation,
          preferences: {
            ...engine.current!.conversation.preferences!,
            muted: true
          }
        }
      }
      engine.emit({ type: 'conversations' })
    })
    expect(control('Unmute')).not.equals(null)
    engine.failMute = true
    await press('Unmute')
    expect(node.textContent).contains(
      'Could not update this conversation. Try again.'
    )
    expect(engine.current!.conversation.preferences!.muted).equals(true)
    engine.failMute = false
    await press('Unmute')
    expect(control('Mute')).not.equals(null)
  })

  it('retains security access when preference support is unavailable and rechecks membership before a stale action', async function () {
    const engine = new InfoEngine()
    Object.defineProperty(engine, 'setPreferences', {
      configurable: true,
      value: undefined
    })
    const node = await render(engine)
    await press('Mute')
    expect(node.textContent).contains(
      'Could not update this conversation. Try again.'
    )
    expect(
      node.querySelector(`[data-testid="chat-info-member-${userIdOfGumbo(2)}"]`)
    ).not.equals(null)
    engine.current = undefined
    await press('Mute')
    expect(engine.changes).deep.equals([])
    await act(async () => {
      engine.emit({ type: 'conversations' })
    })
    expect(node.textContent).not.contains('Aaron Judge')
  })

  it('retries initial loading and forgets private views after membership loss, including an active safety view', async function () {
    const engine = new InfoEngine()
    engine.current = undefined
    const node = await render(engine)
    expect(node.textContent).contains('Chat could not be opened.')
    engine.current = view({
      conversation: chat({ scopeName: 'Harbor' }),
      members: [
        member(userIdOfGumbo(1), 'Trea Turner'),
        member(userIdOfGumbo(2), 'Aaron Judge')
      ]
    })
    await press('Try again')
    expect(node.querySelector('[data-testid="chat-info-hero"]')).not.equals(
      null
    )
    await pressMember(userIdOfGumbo(2))
    expect(
      node.querySelector('[aria-label="Safety number with Aaron Judge"]')
        ?.children.length
    ).equals(12)
    await act(async () => {
      engine.current = undefined
      engine.emit({ type: 'conversation', conversationId: 'cnv_1' })
    })
    expect(node.textContent)
      .contains('Chat could not be opened.')
      .and.not.contains('Aaron Judge')
    expect(node.querySelector('[data-testid="chat-info-hero"]')).equals(null)
  })

  it('makes legacy links reveal the member section and clears the local safety Back override when a member departs', async function () {
    const engine = new InfoEngine()
    const overrides: Array<(() => void) | null> = []
    const node = await render(engine, { showMembers: true })
    const scroller = [...node.querySelectorAll<HTMLElement>('div')].find(
      element => getComputedStyle(element).overflowY === 'auto'
    )!
    const moves: number[] = []
    scroller.scroll = options => {
      moves.push((options as ScrollToOptions).top ?? 0)
    }
    const section = node.querySelector<
      HTMLElement & {
        __reactLayoutHandler: (event: unknown) => void
      }
    >('[data-testid="chat-info-members"]')!
    await act(async () => {
      section.__reactLayoutHandler({
        nativeEvent: { layout: { y: 600, x: 0, width: 350, height: 200 } }
      })
    })
    expect(moves).contains(600)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <HeaderSlotProvider
            headerHeight={48}
            onHandoff={() => {}}
            onBackOverride={handler => overrides.push(handler)}
          >
            <ChatInfoScreen
              engine={engine}
              client={{ leaveDm: async () => ({ closed: false }) }}
              conversationId="cnv_1"
              userId={userIdOfGumbo(1)}
              onLeft={() => {}}
            />
          </HeaderSlotProvider>
        </ThemeProvider>
      )
      await new Promise(resolve => setTimeout(resolve, 30))
    })
    await pressMember(userIdOfGumbo(2))
    expect(overrides.at(-1)).a('function')
    await act(async () => {
      overrides.at(-1)!()
    })
    expect(node.querySelector('[data-testid="chat-info-hero"]')).not.equals(
      null
    )
    await pressMember(userIdOfGumbo(2))
    await act(async () => {
      engine.current = {
        ...engine.current!,
        members: [member(userIdOfGumbo(1), 'Trea Turner')]
      }
      engine.emit({ type: 'conversation', conversationId: 'cnv_1' })
    })
    expect(node.textContent).not.contains('Aaron Judge')
    expect(overrides.at(-1)).equals(null)
  })

  it('preserves DM leave behavior, displays closed/read-only/locked states and ignores obsolete leave completions', async function () {
    const engine = new InfoEngine()
    engine.current = view({
      conversation: chat({ kind: 'dm', scope: null, title: 'Aaron Judge' })
    })
    let fail = true
    let left = 0
    let finish: (() => void) | undefined
    const client = {
      leaveDm: async () => {
        if (fail) throw new Error('Unavailable')
        await new Promise<void>(resolve => {
          finish = resolve
        })
        return { closed: true }
      }
    }
    const node = await render(engine, {
      client,
      onLeft: () => {
        left += 1
      }
    })
    await press('Leave this conversation')
    expect(node.textContent).contains('The conversation could not be started.')
    fail = false
    await press('Leave this conversation')
    engine.current = view({
      conversation: chat({ id: 'cnv_new', scopeName: 'Comet', closed: true }),
      composer: 'closed',
      historyLocked: true
    })
    await render(engine, {
      conversationId: 'cnv_new',
      client,
      onLeft: () => {
        left += 1
      }
    })
    await act(async () => {
      finish!()
      await new Promise(resolve => setTimeout(resolve, 30))
    })
    expect(left).equals(0)
    expect(node.querySelector('[data-testid="chat-info-hero"]')!.textContent)
      .contains('Comet')
      .and.contains('closed')
      .and.contains('History is locked')
    expect(control('Leave this conversation')).equals(null)
    await act(async () => {
      engine.current = {
        ...engine.current!,
        composer: 'readOnly',
        conversation: { ...engine.current!.conversation, closed: false }
      }
      engine.emit({ type: 'conversation', conversationId: 'cnv_new' })
    })
    expect(node.textContent).contains('Only season staff post here.')
  })
})
