import { join } from 'node:path'

import { expect } from 'chai'

import { defineHarness } from '../../../core/spec'
import {
  artifactDir,
  click,
  open,
  server,
  startScoring,
  suite
} from '../../../rigs/scoring/webScoring'

/**
 * Scoring offline, held, refused and stalled saves, and leaving with edits queued.
 */
/*
 * Converted from the scoring screen's legacy browser suite: each mocha `it`
 * is a scenario of the same name, on the stack's web build and the
 * `scoring-field` world, in the Mac's Chrome (the field draws in 3D). The
 * old page-side API's switches (offline, stalled, held and refused saves,
 * a hidden opponent) are the stack's fault server and database
 * (`rigs/scoring/webScoring.ts`).
 */
const { add: it, scenarios } = suite()

async function backWithHeldBall(gone: boolean): Promise<void> {
  const { page, unexpected, serverCount } = await open('/games/g1')
  try {
    await startScoring(page)
    await page.waitForFunction(() => location.pathname === '/games/g1/score')
    await page.waitForSelector('canvas')
    // The game page slides away under the scorer; on a busy machine its
    // Schedule button can outlast the field's first frame.
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Schedule"]') == null,
      { timeout: 10000 }
    )
    const saved = page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith('/games/g1/events')
    )
    await click(page, 'Ball')
    await page.waitForSelector('[aria-label="Undo Ball"]')
    // Saved: Back leaves without asking.
    await saved
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Save status"]') == null
    )
    /** Marks the field's canvas, to tell the same screen from a new one. */
    const mark = async (): Promise<void> => {
      await page.evaluate(() => {
        const canvas = document.querySelector('canvas')
        if (canvas != null) canvas.dataset.backMark = 'kept'
      })
    }
    /** Back, then scoring again: at once, or once the screen has gone. */
    const backAndReturn = async (): Promise<string> => {
      await mark()
      await page.evaluate(() => {
        history.back()
      })
      await page.waitForSelector('[aria-label="Full game scoring"]')
      expect(new URL(page.url()).pathname).equals('/games/g1/score-game')
      expect(await page.$('[aria-label="Discard and Exit"]')).equals(null)
      if (gone) {
        await page.waitForFunction(
          () => document.querySelector('[aria-label^="Baseball field"]') == null
        )
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
      await click(page, 'Full game scoring')
      await page.waitForFunction(() => location.pathname === '/games/g1/score')
      await page.waitForSelector('canvas')
      const path = await page.evaluate(() =>
        document.querySelector('canvas[data-back-mark="kept"]') == null
          ? 'opened anew'
          : 'shown again'
      )
      console.log(`Scoring ${path}`)
      return path
    }
    await backAndReturn()
    // Held back by the server: the ball has not reached it. It waits on
    // the tab's own queue of writes, so Back leaves without asking and the
    // ball is there on the way back in, read from the tab's own copy.
    await server.holdSaves(true)
    await click(page, 'Ball')
    await page.waitForSelector('[aria-label="Undo Ball"]')
    await page.waitForSelector('[aria-label*="2 balls"]')
    const returned = await backAndReturn()
    const count = async (): Promise<string> =>
      (await page.evaluate(() => {
        // Plain: the page has no helpers for sucrase's optional chains.
        const board = document.querySelector('[aria-label*=" balls "]')
        return board === null ? null : board.getAttribute('aria-label')
      })) ?? 'no count'
    console.log('Back in with a held ball:', await count())
    /** The scoring screen as it opened again, kept as the run's proof. */
    const shot = async (): Promise<void> => {
      await page.screenshot({
        path: join(
          artifactDir(),
          gone ? 'back-screen-gone.png' : 'back-shown-again.png'
        )
      })
    }
    await page
      .waitForSelector('[aria-label*="2 balls"]', { timeout: 20000 })
      .catch(async (error: unknown) => {
        console.error('Still not 2 balls:', await count())
        await shot()
        throw error
      })
    // The screen shown again keeps its own Undo history; one opened anew
    // offers the plays it opened with as the last play, as any game
    // opened with plays does.
    await page.waitForSelector(
      returned === 'opened anew'
        ? '[aria-label="Undo Last play"]'
        : '[aria-label="Undo Ball"]'
    )
    await shot()
    // The server answers: the held ball is saved, not only drawn.
    await server.holdSaves(false)
    const end = Date.now() + 20000
    while ((await serverCount())?.balls !== 2) {
      if (Date.now() > end)
        throw new Error(
          `The server holds ${JSON.stringify((await serverCount()) ?? null)}, not 2 balls`
        )
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    console.log('The server holds:', JSON.stringify(await serverCount()))
    expect(unexpected).deep.equals([])
  } finally {
    await server.holdSaves(false)
    await page.close()
  }
}
it('opens an unscored game full screen and protects unsaved plays from browser Back', async function () {
  await backWithHeldBall(false)
})
it('keeps a held ball when the scoring screen has gone before scoring opens again', async function () {
  await backWithHeldBall(true)
})
it('keeps scoring offline across leaving, coming back and a swap, and every pitch reaches the server once online', async function () {
  this.timeout(120000)
  const { page, unexpected, serverCount, serverSides } = await open('/games/g1')
  try {
    const balls = async (n: number): Promise<void> => {
      await page.waitForSelector(`[aria-label*=" ${n} balls "]`, {
        timeout: 20000
      })
    }
    /**
     * Back to the Score screen, and Full game scoring again once the
     * scoring screen and its field have gone. `offlineSaid`: the Score
     * screen shows the offline banner (the scorer, as on the phone, draws
     * none of the shell's chrome).
     */
    const backAndReturn = async (offlineSaid = false): Promise<void> => {
      await page.evaluate(() => {
        history.back()
      })
      await page.waitForSelector('[aria-label="Full game scoring"]')
      if (offlineSaid)
        await page.waitForSelector('[data-testid="offlineBanner"]')
      await page.waitForFunction(
        () => document.querySelector('[aria-label^="Baseball field"]') == null
      )
      await new Promise(resolve => setTimeout(resolve, 1000))
      await click(page, 'Full game scoring')
      await page.waitForFunction(() => location.pathname === '/games/g1/score')
      await page.waitForSelector(
        'canvas, [aria-label="Retry loading scoring"]',
        { timeout: 20000 }
      )
    }
    await startScoring(page)
    await page.waitForSelector('canvas')
    const saved = page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith('/games/g1/events')
    )
    await click(page, 'Ball')
    await saved
    // The connection goes: nothing reaches the server from here.
    await server.offline(true)
    await click(page, 'Ball')
    await balls(2)
    await backAndReturn(true)
    // What the scorer sees, coming back with no connection.
    await new Promise(resolve => setTimeout(resolve, 1000))
    await page.screenshot({
      path: join(artifactDir(), 'offline-return.png')
    })
    expect(
      await page.$('[aria-label="Retry loading scoring"]'),
      'scoring opened offline'
    ).equals(null)
    // Scoring opens on the pitches the tab's own copy holds.
    await balls(2)
    await click(page, 'Ball')
    await balls(3)
    // Home and away swapped, still offline: the plays are reset, and the
    // scorer goes on on the swapped sides.
    await click(page, 'Open scoring menu')
    await click(page, 'Swap Home and Away')
    await click(page, 'Reset and Swap')
    await page.waitForSelector('[aria-label^="Hawks 0 · Owls 0"]', {
      timeout: 20000
    })
    await click(page, 'Ball')
    await balls(1)
    await backAndReturn()
    await page.waitForSelector('[aria-label^="Hawks 0 · Owls 0"]', {
      timeout: 20000
    })
    await balls(1)
    await click(page, 'Ball')
    await balls(2)
    expect((await serverSides()).swapped, 'nothing sent while offline').equals(
      false
    )
    // The connection comes back: the swap, then the pitches after it.
    await server.offline(false)
    const end = Date.now() + 60000
    while (
      !(await serverSides()).swapped ||
      (await serverCount())?.balls !== 2
    ) {
      if (Date.now() > end)
        throw new Error(
          `The server holds ${JSON.stringify({ sides: await serverSides(), count: (await serverCount()) ?? null })}`
        )
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    console.log(
      'The server holds:',
      JSON.stringify({ sides: await serverSides(), count: await serverCount() })
    )
    await balls(2)
    expect(unexpected).deep.equals([])
  } finally {
    await server.offline(false)
    await page.close()
  }
})
it('shows a refused save in the "edits not sent" banner and sheet, and clears it', async function () {
  this.timeout(90000)
  const { page } = await open('/games/g1')
  try {
    const shot = async (name: string): Promise<void> => {
      await page.screenshot({
        path: join(artifactDir(), name)
      })
    }
    await startScoring(page)
    await page.waitForSelector('canvas')
    // Scored with no connection, then refused once it is back.
    await server.offline(true)
    await click(page, 'Ball')
    await page.waitForSelector('[aria-label*=" 1 balls "]')
    await server.refuseSaves(true)
    await server.offline(false)
    // The scorer says so on its own screen, in the server's words.
    await page.waitForFunction(
      () => document.body.innerText.includes('Not sent: Not yours to score'),
      { timeout: 30000 }
    )
    // The shell's banner, on the Score screen: the scorer, as on the
    // phone, draws none of the shell's chrome.
    await page.evaluate(() => {
      history.back()
    })
    await page.waitForSelector('[aria-label="Full game scoring"]')
    await page.waitForFunction(
      () => document.querySelector('[aria-label^="Baseball field"]') == null
    )
    const shown = await page
      // A string, not a function: sucrase's `?.` helper is not on the page.
      .waitForFunction(
        `(document.querySelector('[data-testid="offlineBannerText"]') || {}).textContent === '1 edit not sent'`,
        { timeout: 30000 }
      )
      .then(() => true)
      .catch(() => false)
    await shot('refused-banner.png')
    expect(shown, 'the "1 edit not sent" banner').equals(true)
    await click(page, 'Edits not sent')
    await page.waitForSelector('[data-testid="heldEditsSheet"]')
    await page.waitForFunction(() =>
      document.body.innerText.includes('Not yours to score')
    )
    await shot('refused-sheet.png')
    await server.refuseSaves(false)
    await page.locator('[aria-label^="Use Server\'s Copy"]').click()
    await page.waitForFunction(
      () => document.querySelector('[data-testid="offlineBannerText"]') == null,
      { timeout: 20000 }
    )
  } finally {
    await server.offline(false)
    await server.refuseSaves(false)
    await page.close()
  }
})
it('opens scoring at once from what is stored while the server stalls', async function () {
  this.timeout(90000)
  // The away team's default lineup is one this reader may not see: the
  // tab stores none of it, as the device run's stack answered it.
  server.hiddenOpponent(true)
  const { page, unexpected } = await open('/games/g1')
  try {
    await startScoring(page)
    await page.waitForSelector('canvas')
    const saved = page.waitForResponse(
      response =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith('/games/g1/events')
    )
    await click(page, 'Ball')
    await saved
    await page.evaluate(() => {
      history.back()
    })
    await page.waitForSelector('[aria-label="Full game scoring"]')
    await page.waitForFunction(
      () => document.querySelector('[aria-label^="Baseball field"]') == null
    )
    // The server takes every request from here and answers none.
    await server.stall(true)
    await click(page, 'Full game scoring')
    const started = Date.now()
    const shown = await page
      .waitForSelector('[aria-label*=" 1 balls "]', { timeout: 5000 })
      .then(() => true)
      .catch(() => false)
    const elapsed = Date.now() - started
    console.log(
      `Scoring on a stalled server: ${shown ? `board in ${elapsed} ms` : 'no board in 5 s'}`
    )
    // The field draws a moment after the board's label: captured once it
    // has, so the picture shows the "1 balls" the label says.
    if (shown) await new Promise(resolve => setTimeout(resolve, 1000))
    await page.screenshot({
      path: join(artifactDir(), 'open-stalled-web.png')
    })
    expect(shown, 'the board within 5 s, from the tab’s copy').equals(true)
    await server.stall(false)
    await new Promise(resolve => setTimeout(resolve, 1000))
    expect(unexpected).deep.equals([])
  } finally {
    await server.stall(false)
    server.hiddenOpponent(false)
    await page.close()
  }
})
it('warns before the page unloads while a queued edit waits, away from scoring, and not once it is sent', async function () {
  this.timeout(90000)
  const { page, createdPlayers } = await open('/games/g1/score')
  try {
    const unloadAsked = async (): Promise<boolean> => {
      const asked = new Promise<boolean>(resolve => {
        const seen = (dialog: {
          type: () => string
          dismiss: () => Promise<void>
        }): void => {
          if (dialog.type() !== 'beforeunload') return
          dialog.dismiss().catch(() => undefined)
          resolve(true)
        }
        page.once('dialog', seen)
        setTimeout(() => {
          page.off('dialog', seen)
          resolve(false)
        }, 4000)
      })
      page.reload({ timeout: 4000 }).catch(() => undefined)
      return await asked
    }
    await page.waitForSelector('canvas')
    // A team player saved with no connection: a team edit, nothing
    // scored. The rosters and the new player's sheet open first, while the
    // server answers.
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await click(page, 'Create Player')
    await page.waitForSelector('[aria-label="First Name"]')
    await server.offline(true)
    await page.locator('[aria-label="First Name"]').fill('Mookie')
    await page.locator('[aria-label="Last Name"]').fill('Betts')
    await click(page, 'Save and Create Another Player')
    await new Promise(resolve => setTimeout(resolve, 1000))
    await page.keyboard.press('Escape')
    await new Promise(resolve => setTimeout(resolve, 500))
    await page.keyboard.press('Escape')
    await click(page, 'Open scoring menu')
    await click(page, 'Exit Current Game')
    await page.waitForFunction(() => location.pathname === '/games/g1')
    const asked = await unloadAsked()
    console.log('Leave warning with the player queued:', asked)
    expect(asked, 'a beforeunload while the player waits').equals(true)
    // The connection back: the player is sent, and nothing more is asked.
    await server.offline(false)
    const end = Date.now() + 30000
    const created = async (): Promise<boolean> => {
      for (const id of ['away', 'home'])
        if (
          (await createdPlayers(id)).some(player =>
            player.shortName.startsWith('Mookie')
          )
        )
          return true
      return false
    }
    while (!(await created())) {
      if (Date.now() > end)
        throw new Error('The player never reached the server')
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    expect(await unloadAsked(), 'nothing waits').equals(false)
  } finally {
    await server.offline(false)
    await page.close()
  }
})
it('excludes recorded zero scores and resolves direct scoring links', async function () {
  const scored = await open('/games/g1', true)
  try {
    await scored.page.waitForSelector('[aria-label="Box score"]')
    expect(await scored.page.$('[aria-label="Score"]')).equals(null)
    expect(scored.unexpected).deep.equals([])
  } finally {
    await scored.page.close()
  }
  const direct = await open('/games/g1/score')
  try {
    await click(direct.page, 'Open scoring menu')
    await click(direct.page, 'Exit Current Game')
    await direct.page.waitForSelector('[aria-label="Score"]')
    expect(new URL(direct.page.url()).pathname).equals('/games/g1')
    expect(direct.unexpected).deep.equals([])
  } finally {
    await direct.page.close()
  }
})

export default defineHarness({
  id: 'scoring/scoring-screen/offline-queue',
  title:
    'Scoring offline, held, refused and stalled saves, and leaving with edits queued',
  kind: 'e2e',
  covers: ['src/app/scoring/**', 'src/app/field/**'],
  stack: 'isolated',
  fixtures: ['scoring-field'],
  exclusive: false,
  surfaces: {
    // The field draws in 3D: a GPU, so the Mac's Chrome.
    'web-chromium': {
      devices: [],
      browser: { role: 'browser', needs: ['gpu'] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 16,
  guards: [],
  // Offline and stalled servers are set by the scenarios themselves.
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios
})
