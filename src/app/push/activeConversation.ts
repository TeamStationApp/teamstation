import { useEffect } from 'react'
import { AppState } from 'react-native'

import { pushDevice } from '../platform/pushDevice'
import type { PushDevice } from '../platform/pushState'

/**
 * Which conversation this device shows in the foreground, as the platform
 * hears of it (`PushDevice.setActiveConversation`): a wake for it shows
 * nothing there, since the person is reading it. Of several panes, the last
 * one made active holds it, and only its own going clears it.
 */

type Device = Pick<PushDevice, 'setActiveConversation' | 'clearConversation'>

/** The part of `AppState` this reads. */
export interface AppStates {
  currentState: string | null | undefined
  addEventListener: (
    type: 'change',
    listener: (state: string) => void
  ) => { remove: () => void }
}

let showing: string | null = null

/**
 * Whether the app is active in the foreground, where what it shows can be
 * read: a phone's conversation left open in the background, or covered by
 * Notification Center, the app switcher or a call (iOS's `inactive`), reads
 * nothing that arrives, so it still notifies, as `useActiveConversation`
 * holds. A browser's follows its page's visibility.
 */
export function inForeground(states: AppStates = AppState): boolean {
  return states.currentState === 'active'
}

/** Calls `update` with `inForeground` each time the app state changes. */
export function watchForeground(
  update: (foreground: boolean) => void,
  states: AppStates = AppState
): () => void {
  const listening = states.addEventListener('change', state => {
    update(state === 'active')
  })
  return () => {
    listening.remove()
  }
}

/** The conversation the platform was last told is on screen. */
export function activeConversation(): string | null {
  return showing
}

function show(device: Device, conversationId: string): void {
  showing = conversationId
  device.setActiveConversation(conversationId)
  // Opened: what this device showed of it has been seen.
  device.clearConversation(conversationId).catch(() => undefined)
}

function hide(device: Device, conversationId: string): void {
  if (showing !== conversationId) return
  showing = null
  device.setActiveConversation(null)
}

/**
 * Tells the platform `conversationId` is on screen while `active` (the pane
 * is the active one, its window visible) and the app is in the foreground,
 * and that it is not once either ends.
 */
export function useActiveConversation(
  conversationId: string,
  active: boolean,
  device: Device = pushDevice,
  states: AppStates = AppState
): void {
  useEffect(() => {
    if (!active) return
    const follow = (state: string | null | undefined): void => {
      if (state === 'active') show(device, conversationId)
      else hide(device, conversationId)
    }
    follow(states.currentState)
    const listening = states.addEventListener('change', follow)
    return () => {
      listening.remove()
      hide(device, conversationId)
    }
  }, [conversationId, active, device, states])
}

/**
 * What a read does with whether it moved the cursor: one that did takes
 * this device's notifications of the conversation down.
 */
export function clearOnRead(
  conversationId: string,
  device: Device = pushDevice
): (moved: unknown) => void {
  return moved => {
    if (moved === true)
      device.clearConversation(conversationId).catch(() => undefined)
  }
}
