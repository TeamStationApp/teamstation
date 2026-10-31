import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  applyEmulation,
  connectToMaestroChromium,
  type Emulation
} from './browserCdp'
import { attachDevice, connectDaemon } from './maestro'
import type { LocalSettings } from './settings'
import type { WebSession } from './spec'

/**
 * A Chromium that maestro-d owns and drives, sized for the scenario. `page` reads
 * what maestro-d cannot, and is never used to act on the UI.
 */
export async function openWebSession(
  settings: LocalSettings,
  runDir: string,
  size: { width: number; height: number },
  emulation: Emulation = {}
): Promise<WebSession> {
  const device = `web-${randomUUID().slice(0, 8)}`
  const daemon = await connectDaemon(settings, `e2e-${device}`)
  const profile = join(runDir, 'browser-profiles', device)
  mkdirSync(profile, { recursive: true })
  const blank = `about:blank#${device}`
  const m = await attachDevice(daemon, runDir, {
    device,
    platform: 'web',
    url: blank,
    appId: blank,
    extra: {
      browser: 'chromium',
      windowSize: `${size.width}x${size.height}`,
      headed: false,
      userDataDir: profile
    }
  })
  const { browser, page } = await connectToMaestroChromium(profile, blank)
  await applyEmulation(page, emulation)
  return {
    m,
    page,
    close: async () => {
      await browser.disconnect()
      await m.detach()
      await daemon.shutdown()
    }
  }
}
