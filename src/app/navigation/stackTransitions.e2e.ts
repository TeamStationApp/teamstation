/* eslint-disable @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/prefer-optional-chain -- Browser callbacks are serialized without compiler helpers. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { Page } from 'puppeteer'

import { SESSION_COOKIE } from '../../server/auth/tokens'
import { groupFixture } from '../../test/groupFixtures'
import {
  browserSession,
  contains,
  log,
  maestro,
  tap
} from '../../test/refinementsMaestro.e2e'
import { stackBrowserCoverage } from '../../test/stackBrowserCoverage'
import { seedStack } from '../../test/stackTransitionsSeed'

/**
 * Pushed screens, the scoring cover and pill pages, measured frame by frame in
 * maestro-d's own Chromium.
 *
 * Every animation in the app runs on `requestAnimationFrame`, so a gate
 * installed before the app loads can stop the clock: while `__hold` is set the
 * callbacks queue instead of running and the page stands still mid-move for a
 * screenshot. A sampler records each scene and page wrapper's transform on
 * every frame, and sets `__hold` the first time an incoming wrapper is half way
 * in. `before` runs the same taps on a build without any of it and takes the
 * screenshot 100 ms later, which is how master looks: already there.
 *
 * `TS_STACK_CASES` picks cases (`W1,W2,…`); by default all of them run.
 */
const artifacts = process.env.TS_STACK_ARTIFACTS
if (artifacts == null) throw new Error('Supply TS_STACK_ARTIFACTS')
const before = process.argv.includes('before')
const daemonName = process.env.TS_STACK_DAEMON ?? 'stackTransitions'
const chosen = new Set(
  (process.env.TS_STACK_CASES ?? 'W1,W2,W3,W4,W5,W6,W7,W8')
    .split(',')
    .map(name => name.trim())
)

interface Sample {
  t: number
  key: string
  role: string
  x: number
  y: number
}

/** Runs in the page before any of its scripts. */
function installGate(): void {
  const w = window as unknown as {
    __hold: boolean
    __held: boolean
    __sample: string | null
    __samples: Sample[]
    __queue: FrameRequestCallback[]
    __release: () => void
  }
  w.__hold = false
  w.__held = false
  w.__sample = null
  w.__samples = []
  w.__queue = []
  const native = window.requestAnimationFrame.bind(window)
  const offsetOf = (element: Element): { x: number; y: number } => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform)
    return { x: matrix.m41, y: matrix.m42 }
  }
  let sampled = -1
  const sample = (time: number): void => {
    const selector = w.__sample
    // Once a frame: every callback in it sees the same page.
    if (selector == null || time === sampled) return
    sampled = time
    for (const element of document.querySelectorAll(selector)) {
      const html = element as HTMLElement
      const { x, y } = offsetOf(element)
      const { scene, sceneRole, page, pageRole } = html.dataset
      const role =
        sceneRole !== undefined
          ? sceneRole
          : pageRole !== undefined
            ? pageRole
            : ''
      w.__samples.push({
        t: Math.round(time),
        key: scene !== undefined ? scene : page !== undefined ? page : '',
        role,
        x: Math.round(x),
        y: Math.round(y)
      })
      if (w.__held) continue
      const width = innerWidth
      const height = innerHeight
      // Half way: an incoming scene half in, or a scene leaving half out.
      const halfway =
        role === 'incoming'
          ? (x !== 0 && Math.abs(x) <= width / 2) ||
            (y !== 0 && Math.abs(y) <= height / 2)
          : role === 'outgoing' &&
            (Math.abs(x) >= width / 2 || Math.abs(y) >= height / 2)
      if (halfway) {
        w.__held = true
        w.__hold = true
      }
    }
  }
  window.requestAnimationFrame = (callback: FrameRequestCallback): number =>
    native(time => {
      if (w.__hold) {
        w.__queue.push(callback)
        return
      }
      // A sampler that threw must not stop the app's own frame.
      try {
        sample(time)
      } catch (error) {
        ;(window as unknown as { __error: string }).__error = String(error)
      }
      callback(time)
    })
  w.__release = () => {
    w.__hold = false
    const queued = w.__queue.splice(0)
    for (const callback of queued) native(callback)
  }
}

async function main(): Promise<void> {
  await mkdir(join(artifacts!, 'support'), { recursive: true })
  const f = await groupFixture(resolve('dist'))
  const daemon = await maestro(daemonName)
  const { m, page, browser } = await browserSession(
    daemon,
    `${daemonName}-phone`,
    402,
    874,
    artifacts!
  )
  let tests = 0
  const note = async (line: string): Promise<void> => {
    await log(artifacts!, 'web-stack-samples.log', line)
  }
  const pathOf = async (): Promise<string> =>
    await page.evaluate(() => location.pathname + location.search)
  const tapCss = async (css: string): Promise<void> => {
    await page.waitForSelector(css, { timeout: 15000 })
    await m.tapOn({ css, timeout: 15000 })
  }
  const tapTab = async (label: string): Promise<void> => {
    await tapCss(`[role="tablist"]:not([aria-label]) [aria-label="${label}"]`)
  }
  const settle = async (text: string): Promise<void> => {
    await contains(page, text)
    await page
      .waitForNetworkIdle({ idleTime: 150, timeout: 10000 })
      .catch(() => undefined)
    // The text can be on the page while the move that brought it is still
    // sliding; a measurement started then would hold that move instead.
    // Polled on an interval: the gate may hold animation frames.
    await page.waitForFunction(
      () =>
        document.querySelector(
          '[data-scene-role="incoming"], [data-scene-role="outgoing"], [data-page-role="outgoing"]'
        ) === null,
      { polling: 50, timeout: 10000 }
    )
  }
  try {
    await note(
      `$ TS_STACK_CASES=${[...chosen].join(',')} node -r sucrase/register src/app/navigation/stackTransitions.e2e.ts${before ? ' before' : ''}`
    )
    const { gameId } = await seedStack(f)
    await page.evaluateOnNewDocument(installGate)
    // The motion is the point; a browser that prefers less would settle it.
    await page.emulateMediaFeatures([
      { name: 'prefers-reduced-motion', value: 'no-preference' }
    ])
    await page.setViewport({
      width: 402,
      height: 874,
      deviceScaleFactor: 1,
      hasTouch: true,
      isMobile: true
    })
    await browser.setCookie({
      name: SESSION_COOKIE,
      value: f.h.tokens.get(101)!,
      domain: '127.0.0.1',
      path: '/',
      httpOnly: true
    })
    const scenes = '[data-scene]'
    const pages = '[data-page]'
    const home = async (): Promise<void> => {
      await m.openLink({ link: f.h.origin + '/' })
      await settle('Your Home')
      await settle('Demo Hawks')
      await note(
        `page: scenes=${await page.$$eval(scenes, nodes => nodes.length)} reduced=${await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)}`
      )
    }

    /**
     * Taps, holds the frame where the incoming wrapper is half way, and
     * screenshots it; `before` waits 100 ms instead. The samples of the whole
     * move go to the log, and are returned for the case's own checks.
     */
    const measured = async (
      label: string,
      selector: string,
      action: () => Promise<void>,
      screenshot?: string
    ): Promise<Sample[]> => {
      if (before) {
        await action()
        await new Promise(resolve => setTimeout(resolve, 100))
        if (screenshot != null)
          await writeFile(
            join(artifacts!, screenshot),
            await page.screenshot({ type: 'png' })
          )
        return []
      }
      await page.evaluate(sampled => {
        const w = window as unknown as {
          __held: boolean
          __sample: string | null
          __samples: Sample[]
        }
        w.__held = false
        w.__samples = []
        w.__sample = sampled
      }, selector)
      await action()
      const held = await page
        .waitForFunction(
          () => (window as unknown as { __hold: boolean }).__hold,
          // Not on animation frames: the gate is holding those.
          { timeout: 5000, polling: 25 }
        )
        .then(() => true)
        .catch(() => false)
      if (held && screenshot != null)
        await writeFile(
          join(artifacts!, screenshot),
          await page.screenshot({ type: 'png' })
        )
      const extra = held && check != null ? await check(page) : undefined
      check = undefined
      await page.evaluate(() => {
        ;(window as unknown as { __release: () => void }).__release()
      })
      await new Promise(resolve => setTimeout(resolve, 700))
      const samples = await page.evaluate(() => {
        const w = window as unknown as {
          __sample: string | null
          __samples: Sample[]
        }
        w.__sample = null
        return w.__samples
      })
      await note(`${label}: held=${held}${extra == null ? '' : ' ' + extra}`)
      for (const s of samples)
        await note(`  t=${s.t} ${s.role} ${s.key} x=${s.x} y=${s.y}`)
      assert.ok(held, `${label}: never reached half way`)
      tests++
      return samples
    }
    // A check run while the frame is held, for the cover's layering.
    let check: ((page: Page) => Promise<string>) | undefined

    const of = (samples: Sample[], role: string): Sample[] =>
      samples.filter(s => s.role === role)
    const falling = (values: number[]): boolean =>
      values.every((value, index) => index === 0 || value <= values[index - 1])
    const rising = (values: number[]): boolean =>
      values.every((value, index) => index === 0 || value >= values[index - 1])

    const openTeamPlayer = async (): Promise<Sample[]> => {
      await home()
      await tapCss('[role="button"][aria-label^="Demo Hawks"]')
      await settle('Demo Hawks')
      await tapCss('[aria-label="Team sections"] [aria-label="Team"]')
      await settle('Alex L')
      return await measured(
        'W1 push team → player',
        scenes,
        async () => {
          await tap(m, 'Alex L')
        },
        before ? 'web-push-before.png' : 'web-push-after.png'
      )
    }

    if (chosen.has('W1') || chosen.has('W2')) {
      const push = await openTeamPlayer()
      await settle('Alex L')
      if (!before) {
        const incoming = of(push, 'incoming').map(s => s.x)
        const outgoing = of(push, 'outgoing').map(s => s.x)
        assert.ok(incoming.length > 2 && falling(incoming), 'W1 incoming')
        assert.ok(incoming[0] > 300, `W1 incoming starts at ${incoming[0]}`)
        assert.ok(
          Math.min(...outgoing) <= -110 && Math.min(...outgoing) >= -125,
          `W1 outgoing reaches ${Math.min(...outgoing)}`
        )
        const left = await page.$$eval(
          '[data-scene]:not([data-scene-role="covered"])',
          nodes => nodes.length
        )
        assert.equal(left, 1, 'W1 only the player scene remains on show')
        const covered = await page.$$eval(
          '[data-scene-role="covered"]',
          nodes => nodes.map(node => String(node.getAttribute('data-scene')))
        )
        assert.ok(
          covered.length === 1 && covered[0].includes(':team:'),
          `W1 the team stays mounted beneath, covered: ${covered.join(', ')}`
        )
      }
      if (!before && chosen.has('W2')) {
        const back = await measured('W2 header Back', scenes, async () => {
          await tapCss('[aria-label="Back"]')
        })
        const leaving = of(back, 'outgoing').map(s => s.x)
        assert.ok(leaving.length > 2 && rising(leaving), 'W2 outgoing rises')
        await settle('Demo Hawks')
        const path = await pathOf()
        await note(`W2 address ${path}`)
        assert.ok(/^\/teams\/[^?]+\?tab=team$/.test(path), path)
      }
      if (!before && chosen.has('W1')) {
        await page.setViewport({ width: 1280, height: 800 })
        await home()
        await tapCss('[role="button"][aria-label^="Demo Hawks"]')
        await settle('Demo Hawks')
        await tapCss('[aria-label="Team sections"] [aria-label="Team"]')
        await settle('Alex L')
        check = async held =>
          await held.evaluate(() => {
            const nav = document.querySelector(
              '[role="tablist"]:not([aria-label])'
            )
            if (nav == null) return 'wide nav missing'
            const box = nav.getBoundingClientRect()
            const hit = document.elementFromPoint(
              box.x + box.width / 2,
              box.y + box.height / 2
            )
            return `wide nav on top=${hit != null && nav.contains(hit)}`
          })
        await measured('W1 push at 1280×800', scenes, async () => {
          await tap(m, 'Alex L')
        })
        await page.setViewport({
          width: 402,
          height: 874,
          deviceScaleFactor: 1,
          hasTouch: true,
          isMobile: true
        })
      }
    }

    if (!before && chosen.has('W3')) {
      await home()
      await tapTab('Schedule')
      await settle('Upcoming')
      await measured('W3 schedule → game', scenes, async () => {
        await tapCss('[aria-label*="Demo Owls"]')
      })
      await settle('Demo Hawks')
      await measured('W3 game → team', scenes, async () => {
        await tapCss('[role="link"][aria-label="Demo Hawks"]')
      })
      await settle('Demo Hawks')
      for (const step of ['team → game', 'game → schedule']) {
        const back = await measured(
          `W3 browser Back ${step}`,
          scenes,
          async () =>
            await page
              .goBack({ waitUntil: 'domcontentloaded' })
              .then(() => undefined)
        )
        assert.ok(rising(of(back, 'outgoing').map(s => s.x)), step)
      }
      const forward = await measured(
        'W3 browser Forward',
        scenes,
        async () =>
          await page
            .goForward({ waitUntil: 'domcontentloaded' })
            .then(() => undefined)
      )
      assert.ok(falling(of(forward, 'incoming').map(s => s.x)), 'forward')
      // Two stacks of one frame each: the player replaced the team.
      await openTeamPlayer()
      await page.goBack({ waitUntil: 'domcontentloaded' })
      await settle('Demo Hawks')
      await new Promise(resolve => setTimeout(resolve, 700))
      const again = await measured(
        'W3 Forward team → player',
        scenes,
        async () =>
          await page
            .goForward({ waitUntil: 'domcontentloaded' })
            .then(() => undefined)
      )
      assert.ok(falling(of(again, 'incoming').map(s => s.x)), 'forward again')
    }

    if (chosen.has('W4')) {
      await m.openLink({ link: `${f.h.origin}/games/${gameId}` })
      await settle('Demo Owls')
      // Score is the game hero's action for an assigned scorekeeper.
      await tap(m, 'Score')
      await settle('Full game scoring')
      if (!before)
        check = async held =>
          await held.evaluate(() => {
            const inside = (x: number, y: number): boolean => {
              const hit = document.elementFromPoint(x, y)
              const cover = document.querySelector(
                '[data-scene-role="incoming"]'
              )
              return hit !== null && cover !== null && cover.contains(hit)
            }
            const nav = document.querySelector(
              '[role="tablist"]:not([aria-label])'
            )
            const box = nav === null ? null : nav.getBoundingClientRect()
            const chrome = document.querySelector('[data-chrome]')
            const beneath = document.querySelector(
              '[data-scene-role="outgoing"]'
            )
            const z = (node: Element | null): number =>
              node === null ? NaN : Number(getComputedStyle(node).zIndex)
            return `navbar under cover=${box == null ? 'missing' : inside(box.x + box.width / 2, box.y + box.height / 2)} header over the game=${chrome !== null && z(chrome) > z(beneath)} under the cover=${chrome !== null && z(chrome) < z(document.querySelector('[data-scene-role="incoming"]'))}`
          })
      const cover = await measured(
        'W4 cover up',
        scenes,
        async () => {
          await tap(m, 'Full game scoring')
        },
        before ? 'web-cover-before.png' : 'web-cover-after.png'
      )
      await page.waitForSelector('[aria-label="Open scoring menu"]', {
        timeout: 15000
      })
      if (!before) {
        const rise = of(cover, 'incoming').map(s => s.y)
        assert.ok(rise.length > 2 && falling(rise), 'W4 cover rises')
        assert.ok(rise[0] > 700, `W4 cover starts at ${rise[0]}`)
        await tapCss('[aria-label="Open scoring menu"]')
        const down = await measured('W4 cover down', scenes, async () => {
          await tap(m, 'Exit Current Game')
        })
        const fall = of(down, 'outgoing').map(s => s.y)
        assert.ok(fall.length > 2 && rising(fall), 'W4 cover falls')
        await settle('Demo Owls')
      }
    }

    if (chosen.has('W5')) {
      await home()
      await tapCss('[role="button"][aria-label^="Demo Hawks"]')
      await settle('Demo Hawks')
      const pill = async (
        name: string,
        direction: 'right' | 'left',
        screenshot?: string
      ): Promise<void> => {
        const moved = await measured(
          `W5 pill ${name} (${direction})`,
          pages,
          async () => {
            await tapCss(`[aria-label="Team sections"] [aria-label="${name}"]`)
          },
          screenshot
        )
        if (before) return
        const entering = of(moved, 'incoming').map(s => s.x)
        assert.ok(entering.length > 2, `W5 ${name} samples`)
        assert.ok(
          direction === 'right' ? entering[0] > 0 : entering[0] < 0,
          `W5 ${name} enters from the ${direction}`
        )
      }
      await pill(
        'Team',
        'right',
        before ? 'web-pills-before.png' : 'web-pills-after.png'
      )
      if (!before) {
        await pill('Videos', 'left')
        await pill('Stats', 'right')
        await pill('Videos', 'left')
      }
    }

    if (!before && chosen.has('W6')) {
      await m.openLink({ link: `${f.h.origin}/seasons/${f.seasonA}` })
      await settle('Demo Regular')
      const strip = await page.$$eval(
        '[aria-label="Season sections"] [role="tab"]',
        nodes =>
          nodes.map(node => {
            const label = node.getAttribute('aria-label')
            return label === null ? '' : label
          })
      )
      await note(`W6 season pills ${strip.join(', ')}`)
      for (const name of [strip.at(-1), strip[0]])
        if (name != null)
          await measured(`W6 season ${name}`, pages, async () => {
            await tapCss(
              `[aria-label="Season sections"] [aria-label="${name}"]`
            )
          })
      await tapTab('Schedule')
      await settle('Upcoming')
      await measured('W6 schedule Past', pages, async () => {
        await tapCss('[role="tab"][aria-label="Past"]')
      })
    }

    if (!before && chosen.has('W7')) {
      await m.openLink({ link: `${f.h.origin}/games/${gameId}` })
      await settle('Demo Owls')
      // Videos is a layout of its own, with the same hero and pills: crossing
      // it slides only what is under the pills, as Info and Box score do, and
      // leaves both layouts, and the pills, exactly where they were. Every
      // step moves, whether the game opened on Info or on Videos.
      const strip = async (): Promise<string> =>
        await page.$eval(
          '[data-scene-role="top"] [aria-label="Game sections"]',
          node => {
            const box = node.getBoundingClientRect()
            return `${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}`
          }
        )
      // Its pills come with the game's own load, which can land after the
      // text that settled the page.
      await page.waitForSelector(
        '[data-scene-role="top"] [aria-label="Game sections"] [aria-selected="true"]',
        { timeout: 15000 }
      )
      let shown = await page.$eval(
        '[data-scene-role="top"] [aria-label="Game sections"] [aria-selected="true"]',
        node => node.getAttribute('aria-label')
      )
      assert.ok(shown != null, 'W7: the game opens on a chosen pill')
      const home = await strip()
      for (const name of ['Box score', 'Videos', 'Info', 'Box score']) {
        const label = `W7 game ${name}`
        const samples = await measured(
          label,
          `${pages}, [data-page-content]`,
          async () => {
            await tapCss(
              `[data-scene-role="top"] [aria-label="Game sections"] [aria-label="${name}"]`
            )
          }
        )
        if (shown === 'Videos' || name === 'Videos') {
          const layouts = samples.filter(
            s => s.key === 'watch' || s.key === 'sections'
          )
          assert.ok(
            layouts.length > 0 && layouts.every(s => s.x === 0),
            `${label}: the layouts stay where they are`
          )
          assert.ok(
            samples.some(s => s.key === '' && s.role !== '' && s.x !== 0),
            `${label}: what is under the pills slides`
          )
        }
        const at = await strip()
        await note(`${label}: pills at ${at} (first ${home})`)
        assert.equal(at, home, `${label}: the pills stay where they were`)
        shown = name
      }
      // And scrolled, the pills pin under the header on both layouts: a band
      // wrapped in anything as tall as itself would scroll away instead.
      const pinnedAt = async (name: string): Promise<number> => {
        await tapCss(
          `[data-scene-role="top"] [aria-label="Game sections"] [aria-label="${name}"]`
        )
        await new Promise(resolve => setTimeout(resolve, 900))
        const scroll = async (top: number): Promise<void> => {
          await page.evaluate(to => {
            let node = document.querySelector(
              '[data-scene-role="top"] [aria-label="Game sections"]'
            )
            while (
              node != null &&
              !(
                node.scrollHeight > node.clientHeight + 10 &&
                /auto|scroll/.test(getComputedStyle(node).overflowY)
              )
            )
              node = node.parentElement
            if (node == null) throw new Error('No scroller above the pills')
            node.scrollTop = to
          }, top)
          await new Promise(resolve => setTimeout(resolve, 400))
        }
        await scroll(600)
        const y = await page.$eval(
          '[data-scene-role="top"] [aria-label="Game sections"]',
          node => Math.round(node.getBoundingClientRect().y)
        )
        await scroll(0)
        return y
      }
      const top = Number(home.split(' ')[0].split(',')[1])
      const onVideos = await pinnedAt('Videos')
      const onInfo = await pinnedAt('Info')
      await note(
        `W7 pinned: pills at y=${onVideos} on Videos, ${onInfo} on Info (${top} unscrolled)`
      )
      assert.ok(onVideos < top, 'W7: the pills pin on Videos')
      assert.equal(onVideos, onInfo, 'W7: and where they pin on Info')
    }

    if (!before && chosen.has('W8')) {
      // Back shows the covered screen where it stood: scrolled as it was,
      // since a hidden scene keeps its layout. A short window, so the
      // fixture's Home scrolls.
      const phone = {
        width: 402,
        deviceScaleFactor: 1,
        hasTouch: true,
        isMobile: true
      }
      await page.setViewport({ ...phone, height: 480 })
      await home()
      // No `?.` or `??` in a page function: the build's helpers for them do
      // not exist in the page.
      const scrolled = await page.evaluate(() => {
        const top = document.querySelector('[data-scene-role="top"]')
        if (top === null) return -1
        const scroller = [...top.querySelectorAll<HTMLElement>('*')].find(
          node => {
            const { overflowY } = getComputedStyle(node)
            return (
              (overflowY === 'auto' || overflowY === 'scroll') &&
              node.scrollHeight > node.clientHeight + 120
            )
          }
        )
        if (scroller === undefined) return -1
        scroller.dataset.w8 = ''
        scroller.scrollTop = 120
        return scroller.scrollTop
      })
      assert.ok(scrolled > 0, `W8: Home scrolls (${scrolled})`)
      await tapCss(
        '[data-scene-role="top"] [role="button"][aria-label^="Demo Hawks"]'
      )
      await settle('Demo Hawks')
      await page.goBack({ waitUntil: 'domcontentloaded' })
      await settle('Your Home')
      const back = await page.$eval('[data-w8]', node => node.scrollTop)
      await note(`W8 Home scrolled to ${scrolled}, after Back ${back}`)
      assert.equal(back, scrolled, 'W8: Back keeps Home where it was scrolled')
      await page.setViewport({ ...phone, height: 874 })
    }

    if (!before && process.env.TS_COVERAGE_BASE != null)
      await stackBrowserCoverage(
        page,
        f.h.origin,
        join(artifacts!, 'support', 'browser-coverage.json'),
        tests
      )
  } finally {
    await m.detach()
    await browser.close().catch(() => undefined)
    await daemon.shutdown()
    await f.h.close()
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
