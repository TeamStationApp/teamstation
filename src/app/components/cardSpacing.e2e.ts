import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

interface Device {
  launchApp: (params: Record<string, unknown>) => Promise<unknown>
  stopApp: (params: Record<string, unknown>) => Promise<unknown>
  openBrowser: (params: Record<string, unknown>) => Promise<unknown>
  tapOn: (params: Record<string, unknown>) => Promise<unknown>
  assertVisible: (params: Record<string, unknown>) => Promise<unknown>
  scrollUntilVisible: (params: Record<string, unknown>) => Promise<unknown>
  screenshot: () => Promise<Uint8Array>
  hierarchy: () => Promise<unknown>
  evalBrowserScript: (params: Record<string, unknown>) => Promise<unknown>
  detach: () => Promise<void>
}
interface Daemon {
  attach: (params: Record<string, unknown>) => Promise<Device>
  shutdown: () => Promise<void>
}
interface Client {
  connect: (params: Record<string, unknown>) => Promise<Daemon>
}

/**
 * Runs against the synthetic preview built from the production components.
 * The caller supplies one already-booted, idle device, or one Chromium session.
 * Device startup/shutdown belongs to the caller; the browser closes on detach.
 */
async function main(): Promise<void> {
  const required = (key: string): string => {
    const value = process.env[key]
    assert(value != null && value !== '', `Set ${key}`)
    return value
  }
  const platform = required('CARD_SPACING_PLATFORM')
  assert(['ios', 'android', 'web'].includes(platform))
  const clientRoot = required('MAESTRO_D_CLIENT_ROOT')
  const { MaestroD } = createRequire(join(resolve(clientRoot), 'package.json'))(
    'maestro-d'
  ) as { MaestroD: Client }
  const artifacts = resolve(required('CARD_SPACING_ARTIFACTS'))
  await mkdir(artifacts, { recursive: true })
  const daemon = await MaestroD.connect({ name: required('MAESTRO_D') })
  let device: Device | undefined
  const steps: string[] = []
  try {
    device = await daemon.attach({
      device: required('CARD_SPACING_DEVICE'),
      platform,
      ...(platform === 'web'
        ? {
            appId: required('CARD_SPACING_URL'),
            extra: {
              browser: 'chromium',
              windowSize: process.env.CARD_SPACING_WINDOW ?? '390x844'
            }
          }
        : { appId: process.env.CARD_SPACING_APP_ID ?? 'app.teamstation.app' }),
      artifacts: 'on-failure'
    })
    const m = device
    if (platform !== 'web') {
      const appId = process.env.CARD_SPACING_APP_ID ?? 'app.teamstation.app'
      await m.stopApp({ appId })
      await m.launchApp({ appId })
    }
    const visible = async (text: string): Promise<void> => {
      await m.assertVisible({ text, timeout: 15000 })
      steps.push(`Visible: ${text}`)
    }
    const tap = async (text: string): Promise<void> => {
      await m.tapOn({ text, timeout: 10000 })
      steps.push(`Tapped: ${text}`)
    }
    const scrollTo = async (text: string): Promise<void> => {
      await m.scrollUntilVisible({
        element: { text },
        direction: 'DOWN',
        timeout: 20000
      })
    }
    const shot = async (name: string): Promise<void> => {
      await writeFile(join(artifacts, `${name}.png`), await m.screenshot())
      await writeFile(
        join(artifacts, `${name}.json`),
        JSON.stringify(await m.hierarchy(), null, 2)
      )
    }
    await visible('YOUR PLAYERS')
    await visible('YOUR TEAMS')
    if (platform === 'web') {
      await m.evalBrowserScript({
        script: `
        for (const label of ['Babe Ruth', 'Comets, Example Season · 3–2']) {
          const row = document.querySelector('[aria-label="' + label + '"]');
          if (!row) throw new Error('Missing row: ' + label);
          const box = row.getBoundingClientRect();
          const children = Array.from(row.children).map(node => node.getBoundingClientRect());
          const insets = [
            Math.min(...children.map(b => b.top)) - box.top,
            box.bottom - Math.max(...children.map(b => b.bottom)),
            Math.min(...children.map(b => b.left)) - box.left,
            box.right - Math.max(...children.map(b => b.right))
          ];
          if (insets.some(n => Math.abs(n - 16) > 0.6)) throw new Error(label + ': ' + insets.join('/'));
          const parent = getComputedStyle(row.parentElement);
          if (parseFloat(parent.paddingTop) > 0 || parseFloat(parent.paddingBottom) > 0)
            throw new Error('The list card adds outer padding');
        }
      `
      })
      steps.push('Measured four content insets on the actual Home rows')
    }
    await shot('home')
    const beforeUrl = process.env.CARD_SPACING_BEFORE_URL
    if (platform === 'web' && beforeUrl != null) {
      await m.openBrowser({ url: beforeUrl })
      await visible('YOUR TEAMS')
      await shot('home-before')
      await m.openBrowser({ url: required('CARD_SPACING_URL') })
      await visible('YOUR PLAYERS')
    }
    await tap('^Babe Ruth$')
    await visible('Light / Normal / Babe Ruth')
    await tap('.*Comets.*')
    await visible('Light / Normal / Comets')
    await scrollTo('Kites')
    await shot('home-scrolled')
    await tap('^Geometry$')
    await visible('Geometry passed: five regions')
    await shot('geometry-light')
    await tap('^Dark$')
    await visible('Geometry passed: five regions')
    await shot('geometry-dark')
    await tap('^Large$')
    await visible('Geometry passed: five regions')
    await shot('geometry-dark-large')
    await tap('^Dark$')
    await visible('Geometry passed: five regions')
    await shot('geometry-light-large')
    await tap('^Large$')
    await tap('^Cards$')
    await visible('Empty state')
    await shot('cards')
    await tap('More for Comets')
    await visible('Inspect child')
    await tap('Inspect child')
    await visible('Light / Normal / Menu')
    await scrollTo('Mixed row')
    await tap('Mixed row')
    await visible('Light / Normal / Mixed')
    await scrollTo('Form action')
    await tap('Form action')
    await visible('Light / Normal / Action')
    await scrollTo('Add Admin')
    await tap('^Add Admin$')
    await visible('Light / Normal / Add role')
    await shot('roles')
    await writeFile(
      join(artifacts, 'result.json'),
      JSON.stringify({ platform, passed: true, steps }, null, 2)
    )
    console.log(`${platform}: PASS (${steps.length} assertions/actions)`)
  } catch (error) {
    await writeFile(
      join(artifacts, 'result.json'),
      JSON.stringify(
        { platform, passed: false, steps, error: String(error) },
        null,
        2
      )
    )
    if (device != null)
      await writeFile(
        join(artifacts, 'failure.png'),
        await device.screenshot()
      ).catch(() => undefined)
    throw error
  } finally {
    await device?.detach()
    await daemon.shutdown()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
