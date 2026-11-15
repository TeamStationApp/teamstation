import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  applyEmulation,
  browserFor,
  connectToMaestroChromium,
  type Emulation
} from './browserCdp'
import { browserClassOf } from './goldens'
import { attachDevice, connectDaemon, type MaestroDevice } from './maestro'
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
  let m: MaestroDevice | undefined
  let connected:
    Awaited<ReturnType<typeof connectToMaestroChromium>> | undefined
  const close = async (): Promise<void> => {
    await connected?.browser.disconnect().catch(() => undefined)
    await m?.detach().catch(() => undefined)
    await daemon.shutdown()
  }
  // A session that fails to open closes what it had opened: a browser or
  // daemon left behind holds the device the next run asks for.
  try {
    const profile = join(runDir, 'browser-profiles', device)
    mkdirSync(profile, { recursive: true })
    const blank = `about:blank#${device}`
    m = await attachDevice(daemon, runDir, {
      device,
      platform: 'web',
      url: blank,
      appId: blank,
      extra: {
        browser: await browserFor(emulation),
        windowSize: `${size.width}x${size.height}`,
        headed: false,
        userDataDir: profile
      }
    })
    connected = await connectToMaestroChromium(profile, blank)
    const { browser, page } = connected
    await applyEmulation(page, emulation)
    return {
      m,
      page,
      deviceClass: browserClassOf(await browser.version(), size),
      resize: async next => {
        await page.setViewport(next)
      },
      close
    }
  } catch (error) {
    await close().catch(() => undefined)
    throw error
  }
}
