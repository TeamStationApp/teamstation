import { deviceStorage } from '../platform/deviceStorage'
import {
  ALL_ON,
  type NotificationSwitches,
  readAsked,
  writeAsked
} from '../platform/notificationSwitches'
import type { PushClient, PushDevice } from '../platform/pushState'
import type { UserSettingStorage } from '../platform/userSetting'

/**
 * The moments the app asks about notifications: after an RSVP, on entering
 * messaging, and on turning on a League management notice (an umpire
 * notification setting), which asks past the asked record (`again`).
 */
export type AskReason = 'rsvp' | 'messaging' | 'leagueManagement'

/** What the ask needs of a device (`sharedPushDevice`). */
export type AskDevice = Pick<
  PushDevice,
  'state' | 'switches' | 'setSwitches' | 'enable'
>

/** The permission the ask's question is shown for. */
export type AskQuestion = 'prompt' | 'denied'

/**
 * The question to show, and whether it is this device's first ask of the
 * person (`first`), which turns all three switches on, or a League
 * management ask on a device that asked them before, which turns on only
 * League management.
 */
export interface AskStart {
  question: AskQuestion
  first: boolean
}

/** How the person answered the question. */
export type AskAnswer = 'notNow' | 'continue'

export interface AskOptions {
  /** Where the switches and the record are kept; the device's own by default. */
  storage?: UserSettingStorage
  /** Opens this device's notification settings; answers whether it could. */
  openSettings?: () => Promise<boolean>
}

export interface StartAskOptions extends AskOptions {
  /**
   * Asks past the asked record (a League management ask): a device that
   * asked the person before is asked again, and its answer turns on only
   * League management, leaving Messages and RSVP events as stored.
   */
  again?: boolean
}

/** What an answer turns on: all three on a first ask, else League management. */
const turnedOn = (first: boolean): Partial<NotificationSwitches> =>
  first ? ALL_ON : { leagueManagement: true }

/**
 * The start of the app's ask for `userId`, once per person on this device
 * unless `again`:
 *
 * - asked already (and not `again`), or on a device that cannot notify:
 *   nothing, and nothing is kept;
 * - allowed already: the switches on (all three on a first ask, only League
 *   management on one asked before), the registration told
 *   (`setSwitches`), and the ask kept as done, with no question;
 * - not decided yet, or refused at the system: the question to show, and
 *   whether it is the first (`answerAsk` finishes it).
 */
export async function startAsk(
  device: AskDevice,
  client: PushClient,
  userId: string,
  { storage = deviceStorage, again = false }: StartAskOptions = {}
): Promise<AskStart | undefined> {
  const asked = await readAsked(userId, storage)
  if (asked && !again) return undefined
  const state = await device.state()
  if (state === 'unsupported') return undefined
  const first = !asked
  if (state === 'granted') {
    await Promise.all([
      device.setSwitches(client, userId, turnedOn(first)),
      first ? writeAsked(userId, storage) : undefined
    ])
    return undefined
  }
  return { question: state, first }
}

/**
 * The person's answer to `start`'s question, kept so they are never asked
 * again (but by a League management ask). Not Now changes nothing else.
 * Continue turns the switches on (all three on a first ask, only League
 * management on one asked before), and then, not decided yet, asks the
 * system (`enable`), whose refusal leaves them on with Account's blocked
 * line; refused at the system, opens this device's notification settings.
 * Answers `hint` where those cannot be opened (the web), for the question to
 * say where to allow them instead.
 *
 * Continue's system question is asked at once, while the tap still counts as
 * one to a browser; the switches are stored in a turn queued ahead of the
 * registration it makes (`sharedPushDevice`), so it registers with them on.
 * Refused at the system, the way to settings waits only for the switches to
 * be stored on this device (`switches`, read in the store's turn after the
 * change), not for the server to be told: that goes on behind, in the
 * device's own turn, however slow the link.
 */
export async function answerAsk(
  device: AskDevice,
  client: PushClient,
  userId: string,
  { question, first }: AskStart,
  answer: AskAnswer,
  { storage = deviceStorage, openSettings }: AskOptions = {}
): Promise<'done' | 'hint'> {
  const kept = writeAsked(userId, storage)
  if (answer === 'notNow') {
    await kept
    return 'done'
  }
  const switched = device.setSwitches(client, userId, turnedOn(first))
  if (question === 'prompt') {
    await Promise.all([kept, switched, device.enable(client, userId)])
    return 'done'
  }
  switched.catch(() => undefined)
  await Promise.all([kept, device.switches(userId)])
  const opened = (await openSettings?.().catch(() => false)) === true
  return opened ? 'done' : 'hint'
}
