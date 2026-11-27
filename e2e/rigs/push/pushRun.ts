import { BlockedError } from '../../core/result'
import type { HarnessContext } from '../../core/spec'

/** The device runs of the notification scenarios: the browser, an Android phone and an iPhone. */
export type PushRun = 'web' | 'android' | 'ios'

/** One push the stack's push capture took instead of sending it on. */
export interface CapturedPush {
  at: number
  /** `web`, `fcm` or `apns`: the sender it was handed to. */
  via: string
  /** The device registration it was addressed to. */
  to: string
  /** What the app reads from it: `chat:<conversation>` or `event:<id>`. */
  tag?: string
  payload: unknown
}

/**
 * The pushes the stack's `push-capture` service took since `since`. A spec
 * declares `push-capture`, so a stack without it never reaches here; one
 * without control routes blocks the scenario.
 */
export async function capturedPushes(
  ctx: HarnessContext,
  since: number
): Promise<CapturedPush[]> {
  const control = ctx.stack.control
  if (control == null) {
    throw new BlockedError('this stack has no control routes for push-capture')
  }
  const reply = (await control.push(since)) as { pushes?: CapturedPush[] }
  return reply.pushes ?? []
}

/**
 * One device run of the notification scenarios, N1–N4 in the browser and N5
 * and N6 on a phone, against the stack, its push capture and the device the
 * scenario was handed. Their navigation is still in the legacy modules
 * `src/app/notifications.e2e.ts` and
 * `mobile/test/teamStationAppNotifications.e2e.ts`, which start an API, a
 * database and the app on the machine they run on; it moves here, onto the
 * stack, when the platform category converts those modules. Until then the
 * run blocks, naming that, rather than starting anything on this machine.
 */
export async function pushRun(
  ctx: HarnessContext,
  run: PushRun
): Promise<void> {
  await capturedPushes(ctx, Date.now())
  throw new BlockedError(
    `${run}: the notification steps still start their own API and app (src/app/notifications.e2e.ts, mobile/test/teamStationAppNotifications.e2e.ts); they run on the stack once the platform category converts them`
  )
}
