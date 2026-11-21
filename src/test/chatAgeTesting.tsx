import { afterEach, beforeEach } from 'mocha'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  type ChatAccess,
  ChatAgeContext,
  ChatAgeHost,
  type ChatAgeState,
  useChatAgeRequests
} from '../app/chat/AgeGate'
import type { AgeView } from '../common/age'
import { TeamStationClient } from '../common/api'

/** What a test's chat age stand-in was asked to do. */
export interface ChatAgeRecord {
  /** Each answer the modal gave. */
  answers: unknown[]
  requests: number
}

export function chatAgeRecord(): ChatAgeRecord {
  return { answers: [], requests: 0 }
}

/**
 * The Shell's chat age state for a screen drawn alone: a fixed starting
 * access, the real modal for any request, and an answer of 18 or older that
 * opens chat (or fails, with `failConfirm`).
 */
export function TestChatAge(props: {
  access: ChatAccess
  /** The person signed in. */
  userId?: string
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
  const answer = useCallback(
    async (body: unknown) => {
      record.answers.push(body)
      if (failConfirm) throw new Error('offline')
      setAccess('allowed')
      return 'adult' as const
    },
    [failConfirm, record]
  )
  const state = useMemo<ChatAgeState>(
    () => ({
      access,
      answer,
      apple: 'none',
      userId: props.userId,
      retry: () => undefined,
      failed: false,
      ask,
      requests,
      settle
    }),
    [access, ask, answer, props.userId, requests, settle]
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

/**
 * Presses a part of the age modal: "Enter Birth Year and Month", "I'm 18 or
 * Older", its close control, Save or Back on the year and month, or the
 * notice's OK.
 */
export function pressChatAge(
  choice: 'enter' | 'adult' | 'close' | 'save' | 'back' | 'ok'
): void {
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

/** An adult's age, as a test's Shell reads it. */
export const ADULT_AGE: AgeView = {
  band: 'adult',
  birthYear: null,
  birthMonth: null,
  isAdult: true,
  ageSource: 'self',
  ageSetAt: '2027-04-10T12:00:00.000Z'
}

/** Somebody with no age on file. */
export const NO_AGE: AgeView = {
  band: 'unknown',
  birthYear: null,
  birthMonth: null,
  isAdult: false,
  ageSource: null,
  ageSetAt: null
}

// The client's own `myAge`, as it was before any test replaced it.
const realMyAge = Object.getOwnPropertyDescriptor(
  TeamStationClient.prototype,
  'myAge'
)
function stubConfirmed(): void {
  TeamStationClient.prototype.myAge = async () => ADULT_AGE
}
function restoreChatAge(): void {
  if (realMyAge != null)
    Object.defineProperty(TeamStationClient.prototype, 'myAge', realMyAge)
}

/**
 * Called inside a `describe` that mounts the signed-in `App`: each of its
 * cases reads the account as an adult's, as the Shell asks on mount,
 * so its chat surfaces open and no unanswered request reaches the network.
 * Inside a `describe`, not at a file's top level: the test bundles run many
 * files in one mocha run, where a top-level hook would apply to every file.
 * A case may replace the stub; the client's own method is put back after each.
 */
export function confirmedChatAgeHooks(): void {
  beforeEach(stubConfirmed)
  afterEach(restoreChatAge)
}
