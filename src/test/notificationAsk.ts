/**
 * The app asks about notifications once per person per device, after an
 * RSVP and on entering messaging (`NotificationAskHost`). End-to-end
 * scripts that go there and are not about notifications answer it Not Now
 * with these, right after the step that can bring it up: each waits a
 * bounded time for the sheet, and does nothing when it does not come.
 *
 * The sheet waits for chat's own gates (the age sheet, this device's
 * approvals), so it can come up some seconds after the chat has drawn.
 */
import type { Page } from 'puppeteer'

import { askedKey } from '../app/platform/notificationSwitches'

/** The sheet's Not Now, by id: the age sheet and iOS's own say Not Now too. */
export const ASK_NOT_NOW = 'notification-ask-not-now'

/** How long the ask may take to come up after the step that asks. */
export const ASK_WAIT_MS = 10000

const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Puppeteer: answers the ask Not Now if it comes up within `ms`, and waits
 * for the sheet to go. Given the signed-in `userId`, it stops waiting as
 * soon as this browser has asked them already. Says whether it answered.
 */
export async function dismissNotificationAsk(
  page: Page,
  { userId, ms = ASK_WAIT_MS }: { userId?: string; ms?: number } = {}
): Promise<boolean> {
  const selector = `[data-testid="${ASK_NOT_NOW}"]`
  const asked = userId == null ? undefined : askedKey(userId)
  const deadline = Date.now() + ms
  for (;;) {
    const button = await page.$(selector)
    if (button != null && (await button.isVisible())) {
      // The sheet slides up: press once it has come to rest.
      let last = ''
      for (let tries = 0; tries < 20; tries++) {
        const box = JSON.stringify(await button.boundingBox())
        if (box === last) break
        last = box
        await pause(100)
      }
      await button.click()
      await page.waitForSelector('[data-testid="notification-ask"]', {
        hidden: true,
        timeout: 10000
      })
      return true
    }
    if (
      asked != null &&
      (await page.evaluate(key => localStorage.getItem(key) != null, asked))
    )
      return false
    if (Date.now() >= deadline) return false
    await pause(250)
  }
}

/** What `dismissNotificationAskOn` needs of a maestro-d device. */
export interface AskDevice {
  assertVisible: (options: { id: string; timeout: number }) => Promise<unknown>
  tapOn: (options: { id: string; timeout: number }) => Promise<unknown>
}

/**
 * maestro-d, on a phone or a browser: answers the ask Not Now if it comes up
 * within `ms`. Says whether it answered.
 */
export async function dismissNotificationAskOn(
  m: AskDevice,
  ms = ASK_WAIT_MS
): Promise<boolean> {
  try {
    await m.assertVisible({ id: ASK_NOT_NOW, timeout: ms })
  } catch {
    return false
  }
  // The sheet slides up: a tap while it moves can land beside the button.
  await pause(800)
  await m.tapOn({ id: ASK_NOT_NOW, timeout: 5000 })
  return true
}
