/* eslint-disable @typescript-eslint/prefer-optional-chain -- Puppeteer serializes browser callbacks without Sucrase helpers. */
import type { Page } from 'puppeteer'
/**
 * E11's browser assertions, also run without a native device. Given the full
 * game's `maxGameCameras`, from its camera list, Record Video is disabled with
 * the game's sentence; given `undefined`, it is enabled with no sentence.
 */
export async function waitForCameraLimit(
  page: Page,
  maxGameCameras: number | undefined
): Promise<void> {
  const sentence =
    maxGameCameras == null
      ? null
      : `This game already has ${maxGameCameras} cameras. End one to add another.`
  await page.waitForFunction(
    (words: string | null) => {
      const record = document.querySelector('[data-testid="record-video"]')
      const message = document.querySelector(
        '[data-testid="record-video-limit"]'
      )
      if (record == null) return false
      return words != null
        ? record.getAttribute('aria-disabled') === 'true' &&
            message != null &&
            message.textContent === words
        : record.getAttribute('aria-disabled') !== 'true' && message == null
    },
    { timeout: 20000 },
    sentence
  )
}
