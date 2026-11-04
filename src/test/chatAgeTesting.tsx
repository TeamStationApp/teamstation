import { afterEach, beforeEach } from 'mocha'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  type ChatAccess,
  ChatAgeContext,
  ChatAgeHost,
  type ChatAgeState,
  useChatAgeRequests
} from '../app/chat/ChatAgeGate'
import { TeamStationClient } from '../common/api'
import type { ChatAge } from '../common/chatAge'

/** What a test's chat age stand-in was asked to do. */
export interface ChatAgeRecord {
  confirms: number
  requests: number
}

export function chatAgeRecord(): ChatAgeRecord {
  return { confirms: 0, requests: 0 }
}

/**
 * The Shell's chat age state for a screen drawn alone: a fixed starting
 * access, the real sheet for any request, and an agreement that unlocks chat
 * (or fails, with `failConfirm`).
 */
export function TestChatAge(props: {
  access: ChatAccess
  failConfirm?: boolean
  record?: ChatAgeRecord
  children: React.ReactNode
}): React.ReactElement {
  const { failConfirm = false, children } = props
  const record = useRef(props.record ?? chatAgeRecord()).current
  const [access, setAccess] = useState(props.access)
  // A test moves access on by drawing again with another.
  useEffect(() => {
    setAccess(props.access)
  }, [props.access])
  // The shipped request bookkeeping, so screen tests run the real thing.
  const { ask, settle, requests } = useChatAgeRequests()
  const confirm = useCallback(async () => {
    record.confirms += 1
    if (failConfirm) throw new Error('offline')
    setAccess('allowed')
  }, [failConfirm, record])
  const state = useMemo<ChatAgeState>(
    () => ({
      access,
      confirm,
      retry: () => undefined,
      failed: false,
      ask,
      requests,
      settle
    }),
    [access, ask, confirm, requests, settle]
  )
  return (
    <ChatAgeContext.Provider value={state}>
      {children}
      <ChatAgeHost
        state={state}
        topKey="root"
        chatSurface={false}
        onLeaveChat={() => undefined}
      />
    </ChatAgeContext.Provider>
  )
}

/** The age sheet on show, or null. */
export function chatAgeSheet(): HTMLElement | null {
  return document.querySelector('[data-testid="chat-age-sheet"]')
}

/** Presses "I'm 13 or Older", "Not Now" or "OK" on the sheet. */
export function pressChatAge(choice: 'agree' | 'decline' | 'ok'): void {
  const target = document.querySelector<HTMLElement>(
    `[data-testid="chat-age-${choice}"]`
  )
  if (target == null) throw new Error(`No ${choice} on the age sheet`)
  target.click()
}

/** The pill tabs on show, by label, and the one selected. */
export function pillTabs(): { labels: string[]; selected?: string } {
  const tabs = [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
  return {
    labels: tabs.map(node => node.textContent ?? ''),
    selected:
      tabs.find(node => node.getAttribute('aria-selected') === 'true')
        ?.textContent ?? undefined
  }
}

export function clickPill(label: string): void {
  const tab = [...document.querySelectorAll<HTMLElement>('[role="tab"]')].find(
    node => node.textContent === label
  )
  if (tab == null) throw new Error(`No ${label} tab`)
  tab.click()
}

/** An account that has unlocked chat, as a test's Shell reads it. */
export const CONFIRMED_CHAT_AGE: ChatAge = {
  confirmed: true,
  source: 'self',
  confirmedAt: '2027-04-10T12:00:00.000Z'
}

// The client's own `chatAge`, as it was before any test replaced it.
const realChatAge = Object.getOwnPropertyDescriptor(
  TeamStationClient.prototype,
  'chatAge'
)
function stubConfirmed(): void {
  TeamStationClient.prototype.chatAge = async () => CONFIRMED_CHAT_AGE
}
function restoreChatAge(): void {
  if (realChatAge != null)
    Object.defineProperty(TeamStationClient.prototype, 'chatAge', realChatAge)
}

/**
 * Called inside a `describe` that mounts the signed-in `App`: each of its
 * cases reads the account as confirmed for chat, as the Shell asks on mount,
 * so its chat surfaces open and no unanswered request reaches the network.
 * Inside a `describe`, not at a file's top level: the test bundles run many
 * files in one mocha run, where a top-level hook would apply to every file.
 * A case may replace the stub; the client's own method is put back after each.
 */
export function confirmedChatAgeHooks(): void {
  beforeEach(stubConfirmed)
  afterEach(restoreChatAge)
}
