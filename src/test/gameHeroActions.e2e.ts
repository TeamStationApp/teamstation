import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import express from 'express'

import { maestro } from '../../e2e/rigs/refinementsMaestro'

interface Measurement {
  width: number
  rowWidth: number
  padding: number
  gap: number
  buttons: Array<{
    label: string
    width: number
    textWidth: number
    padding: number
    color: string
  }>
}

/** Build with scripts/build-game-hero-fixture.mjs, then run on the selected simulator. */
async function main(): Promise<void> {
  const device = process.env.TS_HERO_SIMULATOR_UDID
  const directory = process.env.TS_HERO_FIXTURE_DIR
  const output = process.env.TS_HERO_ARTIFACTS
  assert(
    device != null && directory != null && output != null,
    'Supply simulator, fixture directory and artifacts directory'
  )
  await mkdir(output, { recursive: true })
  let measurement: Measurement | undefined
  const app = express()
  app.use(express.json())
  app.post('/measurement', (req, res) => {
    measurement = req.body
    res.sendStatus(204)
  })
  app.get('/', async (_req, res) => {
    const html = await readFile(path.join(directory, 'index.html'), 'utf8')
    res.send(
      html +
        `<script>setInterval(() => {
      if (document.fonts.status !== 'loaded') return;
      const row = document.querySelector('[data-testid="game-hero-actions"]');
      const buttons = [...document.querySelectorAll('[data-testid="game-hero-actions"] [role="button"]')].map(b => {
        const shell = b.firstElementChild, text = shell.firstElementChild;
        const range = document.createRange(); range.selectNodeContents(text);
        return {label: b.getAttribute('aria-label'), width: b.getBoundingClientRect().width,
          textWidth: range.getBoundingClientRect().width, padding: parseFloat(getComputedStyle(shell).paddingLeft),
          color: getComputedStyle(shell).backgroundColor};
      });
      fetch('/measurement', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({
        width: innerWidth, rowWidth: row?.getBoundingClientRect().width ?? 0,
        padding: row ? parseFloat(getComputedStyle(row).paddingLeft) : 0,
        gap: row ? parseFloat(getComputedStyle(row).gap) : 0, buttons})});
    }, 100)</script>`
    )
  })
  app.use(express.static(directory))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  assert(address != null && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const daemon = await maestro('hero-actions-simulator')
  const m = await daemon.attach({
    device,
    platform: 'ios',
    appId: 'com.apple.mobilesafari',
    artifacts: 'on-failure'
  })
  const results: Record<string, Measurement> = {}
  try {
    for (const [role, labels] of [
      ['all', ['Score', 'Record', 'Coach', 'DJ']],
      ['admin', []],
      ['none', []],
      ['coach', ['Coach']],
      ['scorekeeper', ['Score']],
      ['songkeeper', ['DJ']],
      ['videographer', ['Record']]
    ] as Array<[string, string[]]>) {
      measurement = undefined
      await m.openLink({
        link: origin + (role === 'all' ? '/' : `/?role=${role}`)
      })
      await m.assertVisible({ text: 'Owls', timeout: 20000 })
      for (let i = 0; i < 100; i++) {
        if (
          measurement != null &&
          JSON.stringify(
            (measurement as Measurement).buttons.map(b => b.label)
          ) === JSON.stringify(labels)
        )
          break
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      assert(measurement != null, 'Missing layout measurements')
      const value = measurement as Measurement
      await writeFile(
        path.join(output, `${role}-measurement.json`),
        JSON.stringify(value, null, 2)
      )
      if (role === 'all')
        await writeFile(
          path.join(output, 'hero-all-actions.png'),
          await m.screenshot()
        )
      assert.deepEqual(
        value.buttons.map(b => b.label),
        labels
      )
      for (const button of value.buttons) {
        const slot = (value.rowWidth - 2 * value.padding - 3 * value.gap) / 4
        assert(
          Math.abs(button.width - slot) < 1,
          'Actions must occupy equal quarters of the full inner row'
        )
        assert(
          button.textWidth + 2 * button.padding <= button.width + 1,
          'The complete label must fit inside its pill padding'
        )
        if (button.label === 'DJ')
          assert.equal(button.color, 'rgb(91, 33, 182)')
        if (button.label === 'Record')
          assert.equal(button.color, 'rgb(210, 43, 43)')
      }
      results[role] = value
      if (labels.length === 1) {
        assert(
          Math.abs(value.buttons[0].width - results.all.buttons[0].width) < 1
        )
        await m.tapOn({ text: labels[0] })
        if (role !== 'scorekeeper')
          await m.assertVisible({ text: `Action: ${labels[0]}` })
        else await m.assertVisible({ text: 'Full game scoring' })
      }
    }
    await writeFile(
      path.join(output, 'measurements.json'),
      JSON.stringify(results, null, 2)
    )
    console.log(
      'Hero layout, colors and seven role scenarios passed on the selected simulator'
    )
  } finally {
    await m.detach()
    await daemon.shutdown()
    server.closeAllConnections()
    await new Promise<void>(resolve =>
      server.close(() => {
        resolve()
      })
    )
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
