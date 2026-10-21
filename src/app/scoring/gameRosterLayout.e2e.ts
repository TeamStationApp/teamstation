import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const required = (name: string): string => {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}

/** Point at a seeded coach roster with both team players and a game-only guest. */
async function main(): Promise<void> {
  const client = createRequire(
    join(required('MAESTRO_D_CLIENT_ROOT'), 'package.json')
  )
  const { MaestroD } = client('maestro-d')
  const url = required('ROSTER_TEST_URL')
  const artifacts = required('ROSTER_ARTIFACT_DIR')
  const daemon = await MaestroD.connect({ name: required('MAESTRO_D') })
  await mkdir(artifacts, { recursive: true })
  try {
    const m = await daemon.attach({
      device: required('ROSTER_BROWSER_DEVICE'),
      platform: 'web',
      appId: url,
      artifacts: 'on-failure',
      extra: {
        browser: 'chrome',
        windowSize: process.env.ROSTER_WINDOW_SIZE ?? '390x844'
      }
    })
    try {
      await m.openBrowser({ url })
      await m.assertVisible({ text: 'Tap player to edit.', timeout: 30000 })
      await m.evalBrowserScript({
        script: "await document.fonts.ready; return 'ready'"
      })
      await m.evalBrowserScript({
        script: `
          const cards = [...document.querySelectorAll('[data-testid^="Player card "]')];
          if (!cards.length) throw Error('No roster cards with switches');
          for (const card of cards) {
            const toggle = card.querySelector('input[type=checkbox]');
            if (!toggle) throw Error('Missing switch');
            const c = card.getBoundingClientRect(), t = toggle.getBoundingClientRect();
            if (t.left < c.left || t.right > c.right ||
                Math.abs((t.top + t.bottom - c.top - c.bottom) / 2) > 2)
              throw Error('Switch must be centered inside its card');
            if (toggle.closest('[role=button]')) throw Error('Nested switch');
          }
          const guest = document.querySelector('[aria-label*="game-only player"]');
          if (!guest || Math.abs(guest.getBoundingClientRect().width - cards[0].getBoundingClientRect().width) > 2)
            throw Error('Team and guest cards must have equal widths');
          const header = document.querySelector('[aria-label="Game roster information"]').getBoundingClientRect();
          if (header.right > innerWidth || header.left < 0) throw Error('Header overflow');
          return 'Roster layout passed';`
      })
      await writeFile(join(artifacts, 'roster.png'), await m.screenshot())
      await m.tapOn({ text: 'Game roster information' })
      await m.assertVisible({ text: '.*Toggle a player off.*' })
      await m.waitForAnimationToEnd({ timeout: 3000 })
      await m.evalBrowserScript({
        script: `
          const sheet = document.querySelector('[data-testid="Scoring sheet"]').getBoundingClientRect();
          if (sheet.top < 0 || sheet.bottom > innerHeight) throw Error('Help modal clipped');
          return 'Help modal fits';`
      })
      await writeFile(join(artifacts, 'help.png'), await m.screenshot())
      await m.tapOn({ text: '^Done$' })
      await m.assertNotVisible({ text: '.*Toggle a player off.*' })
      console.log('PASS roster cards, centered switches, header and help modal')
    } finally {
      await m.detach()
    }
  } finally {
    await daemon.shutdown()
    daemon.close()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
