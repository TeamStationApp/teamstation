import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { HTTPRequest, Page } from 'puppeteer'

import { isMapFrame } from './mapFrameProbe'

/** Where Google's Maps JavaScript API loads from. */
export const GOOGLE_MAPS_SCRIPT = 'https://maps.googleapis.com/maps/api/js?'

/**
 * Answers the page's requests for Google's Maps script with
 * `googleMapsStub.js`, and lets every other request through. Each request's
 * address, and whether it came from a framed map document, goes to `seen`.
 */
export async function interceptGoogleMaps(
  page: Page,
  seen?: (request: { url: string; fromMap: boolean }) => void
): Promise<void> {
  const stub = readFileSync(resolve('src/test/googleMapsStub.js'), 'utf8')
  await page.setRequestInterception(true)
  page.on('request', (request: HTTPRequest) => {
    const url = request.url()
    const frame = request.frame()
    seen?.({
      url,
      fromMap: isMapFrame(frame) && !url.endsWith('/mapFrame.html')
    })
    if (url.startsWith(GOOGLE_MAPS_SCRIPT))
      request
        .respond({
          status: 200,
          contentType: 'application/javascript',
          body: stub
        })
        .catch(() => undefined)
    else request.continue().catch(() => undefined)
  })
}
