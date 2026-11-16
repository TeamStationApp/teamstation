import { deviceStorage } from './deviceStorage'
import type { UserSettingStorage } from './userSetting'

/**
 * This device's two notification switches for one person: direct messages
 * and mentions, and reminders before the events they said yes to. They are
 * the device's own, not the account's: each phone and browser keeps its own,
 * nothing syncs them, and nobody else's Account shows them.
 */
export interface NotificationSwitches {
  messages: boolean
  rsvpEvents: boolean
}

/** Both off: what a device starts from for anybody. */
export const SWITCHES_OFF: NotificationSwitches = {
  messages: false,
  rsvpEvents: false
}

/** Whether either switch is on. */
export function anySwitchOn(switches: NotificationSwitches): boolean {
  return switches.messages || switches.rsvpEvents
}

/** Where a person's switches are kept on this device. */
export function switchesKey(userId: string): string {
  return `teamstation:notifications:${encodeURIComponent(userId)}`
}

/**
 * This device's switches for `userId`: the browser's `localStorage` or the
 * phone's AsyncStorage (`deviceStorage`). Both off until saved, and for
 * anything unreadable. Signing out leaves them, so signing back in on this
 * device finds them; somebody else signing in here reads their own.
 */
export async function readSwitches(
  userId: string,
  storage: UserSettingStorage = deviceStorage
): Promise<NotificationSwitches> {
  try {
    const raw = await storage.getItem(switchesKey(userId))
    if (raw == null) return SWITCHES_OFF
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value == null) return SWITCHES_OFF
    return {
      messages: 'messages' in value && value.messages === true,
      rsvpEvents: 'rsvpEvents' in value && value.rsvpEvents === true
    }
  } catch {
    return SWITCHES_OFF
  }
}

/** Keeps this device's switches for `userId`; a refused write is dropped. */
export async function writeSwitches(
  userId: string,
  switches: NotificationSwitches,
  storage: UserSettingStorage = deviceStorage
): Promise<void> {
  try {
    await storage.setItem(
      switchesKey(userId),
      JSON.stringify({
        messages: switches.messages,
        rsvpEvents: switches.rsvpEvents
      })
    )
  } catch {
    // The switches stand for this visit, and read as before the next.
  }
}

/**
 * Where this device keeps that it has asked `userId` about notifications
 * (`askedNotifications`), beside their switches.
 */
export function askedKey(userId: string): string {
  return `teamstation:askedNotifications:${encodeURIComponent(userId)}`
}

/**
 * Whether this device has asked `userId` about notifications already, at an
 * RSVP or on entering messaging: once it has, it never asks them again, and
 * never changes their switches itself. Unreadable reads as not asked.
 */
export async function readAsked(
  userId: string,
  storage: UserSettingStorage = deviceStorage
): Promise<boolean> {
  try {
    return (await storage.getItem(askedKey(userId))) != null
  } catch {
    return false
  }
}

/** Keeps that this device has asked `userId`; a refused write is dropped. */
export async function writeAsked(
  userId: string,
  storage: UserSettingStorage = deviceStorage
): Promise<void> {
  try {
    await storage.setItem(askedKey(userId), new Date().toISOString())
  } catch {
    // Asked again on the next visit, as if never asked.
  }
}
