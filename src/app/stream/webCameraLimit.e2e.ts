/* eslint-disable @typescript-eslint/prefer-optional-chain -- Puppeteer serializes browser callbacks without Sucrase helpers. */
import type { Page } from 'puppeteer'
/** E11's browser assertions, also run without a native device. */
export async function waitForCameraLimit(
  page: Page,
  full: boolean
): Promise<void> {
  await page.waitForFunction(
    (expected: boolean) => {
      const record = document.querySelector('[data-testid="record-video"]')
      const message = document.querySelector(
        '[data-testid="record-video-limit"]'
      )
      if (record == null) return false
      return expected
        ? record.getAttribute('aria-disabled') === 'true' &&
            message != null &&
            message.textContent ===
              'This game already has 6 cameras. End one to add another.'
        : record.getAttribute('aria-disabled') !== 'true' && message == null
    },
    { timeout: 20000 },
    full
  )
}
