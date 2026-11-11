/* eslint-disable @typescript-eslint/prefer-optional-chain -- Browser callbacks cannot capture Sucrase helpers. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import express from 'express'

import { browserSession, capture, maestro } from './refinementsMaestro.e2e'

async function main(): Promise<void> {
  const directory = process.env.TS_ICON_ARTIFACTS
  assert(directory != null, 'Supply TS_ICON_ARTIFACTS')
  const phase = process.env.TS_ICON_PHASE ?? 'after'
  const surface = process.env.TS_ICON_SURFACE ?? 'web'
  const daemon = await maestro(process.env.MAESTRO_D ?? 'centerButtonIcons')
  const log = [
    `$ node -r sucrase/register src/test/buttonIcons.e2e.ts (${surface}, ${phase})`
  ]
  try {
    if (surface === 'web') {
      const fixture = process.env.TS_ICON_FIXTURE_DIR
      assert(fixture != null, 'Supply TS_ICON_FIXTURE_DIR')
      const app = express()
      app.use(express.static(fixture))
      const server = app.listen(0, '127.0.0.1')
      await new Promise<void>(resolve => {
        server.once('listening', resolve)
      })
      const address = server.address()
      assert(address != null && typeof address !== 'string')
      try {
        for (const [label, width, height] of [
          ['phone', 390, 844],
          ['desktop', 1280, 900]
        ] as const) {
          const { m, browser, page } = await browserSession(
            daemon,
            `center-icons-${phase}-${label}`,
            width,
            height,
            directory
          )
          try {
            await page.emulateMediaFeatures([
              { name: 'prefers-reduced-motion', value: 'reduce' }
            ])
            page.on('pageerror', error => {
              console.error(error)
            })
            await m.openLink({ link: `http://127.0.0.1:${address.port}` })
            await page.waitForFunction(
              () =>
                document.fonts.status === 'loaded' &&
                document.body.textContent !== null &&
                document.body.textContent.includes('Action: ready')
            )
            await capture(m, directory, `web-${label}-controls-${phase}.png`)
            for (const [text, result] of [
              ['Team settings', 'settings'],
              ['Share', 'share'],
              ['Videos', 'videos']
            ] as const) {
              await m.tapOn({ text, timeout: 10000 })
              await m.assertVisible({
                text: `Action: ${result}`,
                timeout: 10000
              })
            }
            await m.tapOn({ text: 'Show scoring', timeout: 10000 })
            await capture(m, directory, `web-${label}-scoring-${phase}.png`)
            await m.tapOn({ text: 'Open scoring menu', timeout: 10000 })
            await m.assertVisible({ text: 'Action: menu', timeout: 10000 })
            await m.tapOn({ text: 'Mute game sounds', timeout: 10000 })
            await m.assertVisible({ text: 'Action: sound', timeout: 10000 })
            log.push(
              `PASS ${label}: settings/share/menu/sound/navigation actions`
            )
            for (const screen of [
              'chat',
              'tess',
              'stream',
              'player',
              'search',
              'walkup'
            ]) {
              await m.openLink({
                link: `http://127.0.0.1:${address.port}/?screen=${screen}`
              })
              await page.waitForFunction(
                () =>
                  document.fonts.status === 'loaded' &&
                  document.body.textContent !== null &&
                  document.body.textContent.includes('Action: ready')
              )
              await writeFile(
                join(directory, `web-${label}-${screen}-${phase}.png`),
                await m.screenshot()
              )
            }
          } finally {
            await browser.close()
            await m.detach()
          }
        }
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close(error => {
            error == null ? resolve() : reject(error)
          })
        })
      }
    } else {
      const device = process.env.MAESTRO_DEVICE
      const appId = process.env.TS_ICON_APP_ID
      assert(device != null && appId != null, 'Supply native device and app ID')
      const m = await daemon.attach({
        device,
        platform: surface === 'android' ? 'android' : 'ios',
        appId
      })
      try {
        await m.launchApp({ appId })
        await m.assertVisible({ text: 'Action: ready', timeout: 30000 })
        await capture(
          m,
          directory,
          `${surface === 'android' ? 'android' : 'native'}-controls-${phase}.png`
        )
        for (const [text, result] of [
          ['Team settings', 'settings'],
          ['Share', 'share'],
          ['Videos', 'videos']
        ] as const) {
          await m.tapOn({ text, timeout: 10000 })
          await m.assertVisible({ text: `Action: ${result}`, timeout: 10000 })
        }
        await m.tapOn({ text: 'Show scoring', timeout: 10000 })
        await capture(
          m,
          directory,
          `${surface === 'android' ? 'android' : 'native'}-scoring-${phase}.png`
        )
        await m.tapOn({ text: 'Open scoring menu', timeout: 10000 })
        await m.assertVisible({ text: 'Action: menu', timeout: 10000 })
        await m.tapOn({ text: 'Mute game sounds', timeout: 10000 })
        await m.assertVisible({ text: 'Action: sound', timeout: 10000 })
        log.push(
          `PASS ${surface}: settings/share/menu/sound/navigation actions`
        )
      } finally {
        await m.detach()
      }
    }
  } finally {
    await daemon.shutdown()
    await writeFile(
      join(directory, `${surface}-${phase}-actions.log`),
      log.join('\n') + '\n'
    )
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
