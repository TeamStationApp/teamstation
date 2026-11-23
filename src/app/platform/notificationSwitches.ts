import { deviceStorage } from './deviceStorage'
import type { UserSettingStorage } from './userSetting'

/**
 * This device's three notification switches for one person: direct messages
 * and mentions, reminders before the events they said yes to, and League
 * management notices (missing umpires, sign-ups and withdrawals). They are
 * the device's own, not the account's: each phone and browser keeps its own,
 * nothing syncs them, and nobody else's Account shows them.
 */
export interface NotificationSwitches {
  messages: boolean
  rsvpEvents: boolean
  leagueManagement: boolean
}

/** All off: what a device starts from for anybody, until it is asked. */
export const SWITCHES_OFF: NotificationSwitches = {
  messages: false,
  rsvpEvents: false,
  leagueManagement: false
}

/** All on: what a device's first ask turns on. */
export const ALL_ON: NotificationSwitches = {
  messages: true,
  rsvpEvents: true,
  leagueManagement: true
}

/** Whether any switch is on. */
export function anySwitchOn(switches: NotificationSwitches): boolean {
  return switches.messages || switches.rsvpEvents || switches.leagueManagement
}

/** Where a person's switches are kept on this device. */
export function switchesKey(userId: string): string {
  return `teamstation:notifications:${encodeURIComponent(userId)}`
}

/**
 * This device's switches for `userId`: the browser's `localStorage` or the
 * phone's AsyncStorage (`deviceStorage`). All off until saved, and for
 * anything unreadable. A set saved by a build before League management
 * (without `leagueManagement`) reads it as on while either of the other two
 * is on, so a device that receives notifications has it on by default, and
 * off when both are off, so somebody who turned every notification off is
 * not asked by the system, nor shown as blocked, for it. Signing out leaves
 * them, so signing back in on this device finds them; somebody else signing
 * in here reads their own.
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
    const messages = 'messages' in value && value.messages === true
    const rsvpEvents = 'rsvpEvents' in value && value.rsvpEvents === true
    return {
      messages,
      rsvpEvents,
      leagueManagement:
        'leagueManagement' in value
          ? value.leagueManagement === true
          : messages || rsvpEvents
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
        rsvpEvents: switches.rsvpEvents,
        leagueManagement: switches.leagueManagement
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
 * RSVP or on entering messaging: once it has, it never asks them so again,
 * and never changes their switches itself; only a League management ask
 * goes past it, and then turns on League management alone. Unreadable reads as not asked.
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
