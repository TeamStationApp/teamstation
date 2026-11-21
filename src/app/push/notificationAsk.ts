import { deviceStorage } from '../platform/deviceStorage'
import { readAsked, writeAsked } from '../platform/notificationSwitches'
import type { PushClient, PushDevice } from '../platform/pushState'
import type { UserSettingStorage } from '../platform/userSetting'

/** The two moments the app asks about notifications. */
export type AskReason = 'rsvp' | 'messaging'

/** What the ask needs of a device (`sharedPushDevice`). */
export type AskDevice = Pick<
  PushDevice,
  'state' | 'switches' | 'setSwitches' | 'enable'
>

/** The permission the ask's question is shown for. */
export type AskQuestion = 'prompt' | 'denied'

/** How the person answered the question. */
export type AskAnswer = 'notNow' | 'continue'

export interface AskOptions {
  /** Where the switches and the record are kept; the device's own by default. */
  storage?: UserSettingStorage
  /** Opens this device's notification settings; answers whether it could. */
  openSettings?: () => Promise<boolean>
}

const BOTH_ON = { messages: true, rsvpEvents: true }

/**
 * The start of the app's ask for `userId`, once per person on this device:
 *
 * - asked already, or on a device that cannot notify: nothing, and nothing
 *   is kept;
 * - allowed already: both switches on, the registration told
 *   (`setSwitches`), and the ask kept as done, with no question;
 * - not decided yet, or refused at the system: the question to show
 *   (`answerAsk` finishes it).
 */
export async function startAsk(
  device: AskDevice,
  client: PushClient,
  userId: string,
  { storage = deviceStorage }: AskOptions = {}
): Promise<AskQuestion | undefined> {
  if (await readAsked(userId, storage)) return undefined
  const state = await device.state()
  if (state === 'unsupported') return undefined
  if (state === 'granted') {
    await Promise.all([
      device.setSwitches(client, userId, BOTH_ON),
      writeAsked(userId, storage)
    ])
    return undefined
  }
  return state
}

/**
 * The person's answer to `question`, kept so they are never asked again.
 * Not Now changes nothing else. Continue turns both switches on, and then,
 * not decided yet, asks the system (`enable`), whose refusal leaves them on
 * with Account's blocked line; refused at the system, opens this device's
 * notification settings. Answers `hint` where those cannot be opened (the
 * web), for the question to say where to allow them instead.
 *
 * Continue's system question is asked at once, while the tap still counts as
 * one to a browser; the switches are stored in a turn queued ahead of the
 * registration it makes (`sharedPushDevice`), so it registers with both on.
 * Refused at the system, the way to settings waits only for the switches to
 * be stored on this device (`switches`, read in the store's turn after the
 * change), not for the server to be told: that goes on behind, in the
 * device's own turn, however slow the link.
 */
export async function answerAsk(
  device: AskDevice,
  client: PushClient,
  userId: string,
  question: AskQuestion,
  answer: AskAnswer,
  { storage = deviceStorage, openSettings }: AskOptions = {}
): Promise<'done' | 'hint'> {
  const kept = writeAsked(userId, storage)
  if (answer === 'notNow') {
    await kept
    return 'done'
  }
  const switched = device.setSwitches(client, userId, BOTH_ON)
  if (question === 'prompt') {
    await Promise.all([kept, switched, device.enable(client, userId)])
    return 'done'
  }
  switched.catch(() => undefined)
  await Promise.all([kept, device.switches(userId)])
  const opened = (await openSettings?.().catch(() => false)) === true
  return opened ? 'done' : 'hint'
}
