import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from 'chai'

import { scoringSurface } from '../../../../src/app/theme/scoringSurface'
import { defineHarness } from '../../../core/spec'
import { placeOffered, setTrajectory } from '../../../rigs/fieldPointer'
import {
  addPlaceholders,
  artifactDir,
  click,
  cssColor,
  fieldOf,
  open,
  openPlaceholderSheet,
  overrideBases,
  server,
  suite,
  tapSettled
} from '../../../rigs/scoring/webScoring'

/**
 * The defensive field, roster and lineup editing, and overrides.
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

it('shows the whole defensive field with state colors and drops onto the visible position', async function () {
  const { page } = await open('/games/g1/score')
  try {
    await page.setViewport({ width: 390, height: 500 })
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await click(page, 'Defense')
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="Defensive field"]')!
          .getBoundingClientRect().height > 0
    )
    for (const viewport of [
      { width: 390, height: 500 },
      { width: 844, height: 390 },
      { width: 844, height: 360 },
      { width: 844, height: 238 }
    ]) {
      await page.setViewport(viewport)
      await page.waitForFunction(
        () => {
          // A card is 14% of the field's viewport, at most 46 points.
          const field = document
            .querySelector('[data-testid="Defensive field viewport"]')!
            .getBoundingClientRect()
          const expected = Math.min(46, field.height * 0.14)
          return Array.from(
            document.querySelectorAll('[data-roster-target^="defense-"]')
          ).every(
            node => Math.abs(node.getBoundingClientRect().height - expected) < 1
          )
        },
        { timeout: 5000 }
      )
      const geometry = await page.evaluate(() => {
        const rect = (
          n: Element
        ): { x: number; y: number; width: number; height: number } => {
          const r = n.getBoundingClientRect()
          return { x: r.x, y: r.y, width: r.width, height: r.height }
        }
        const field = rect(
          document.querySelector('[data-testid="Defensive field"]')!
        )
        const targets = Array.from(
          document.querySelectorAll('[data-roster-target^="defense-"]')
        ).map(rect)
        const roster = rect(
          document.querySelector('[aria-label="Roster players"]')!
        )
        return {
          field,
          targets,
          roster,
          fieldScroll:
            document.querySelector('[aria-label="Defensive positions"]') != null
        }
      })
      expect(geometry.fieldScroll).equals(false)
      expect(geometry.roster.height).at.least(48)
      expect(geometry.targets).length(9)
      for (const r of geometry.targets) {
        expect(r.x).at.least(geometry.field.x - 1)
        expect(r.y).at.least(geometry.field.y - 1)
        expect(r.x + r.width).at.most(
          geometry.field.x + geometry.field.width + 1
        )
        expect(r.y + r.height, JSON.stringify(geometry)).at.most(
          geometry.field.y + geometry.field.height + 1
        )
      }
      for (let i = 0; i < geometry.targets.length; i++)
        for (let j = i + 1; j < geometry.targets.length; j++) {
          const a = geometry.targets[i]
          const b = geometry.targets[j]
          expect(
            a.x + a.width <= b.x ||
              b.x + b.width <= a.x ||
              a.y + a.height <= b.y ||
              b.y + b.height <= a.y
          ).equals(true)
        }
    }
    const beforeScroll = await page.$eval(
      '[data-testid="Defensive field"]',
      node => node.getBoundingClientRect().y
    )
    await page.$eval('[aria-label="Roster players"]', node => {
      node.scrollTop = 80
    })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(
      await page.$eval(
        '[data-testid="Defensive field"]',
        node => node.getBoundingClientRect().y
      )
    ).equals(beforeScroll)
    await page.$eval('[aria-label="Roster players"]', node => {
      node.scrollTop = 0
    })
    const style = async (): Promise<{
      border: string
      color: string
      fill: string
    }> =>
      await page.$eval('[data-testid="Defense P card"]', node => {
        const s = getComputedStyle(node)
        return {
          border: s.borderTopStyle,
          color: s.borderTopColor,
          fill: s.backgroundColor
        }
      })
    // A filled position in the scoring surface's accent, an empty one in
    // its red badge.
    expect(await style()).deep.equals({
      border: 'solid',
      color: cssColor(scoringSurface.accent),
      fill: cssColor(scoringSurface.active)
    })
    await click(page, 'Clear P')
    expect(await style()).deep.equals({
      border: 'dashed',
      color: cssColor(scoringSurface.badges.red.border),
      fill: cssColor(scoringSurface.badges.red.background)
    })
    for (const viewport of [
      { width: 844, height: 390 },
      { width: 844, height: 360 },
      { width: 844, height: 238 }
    ]) {
      await page.setViewport(viewport)
      await page.waitForFunction(
        () => {
          // A card is 14% of the field's viewport, at most 46 points.
          const field = document
            .querySelector('[data-testid="Defensive field viewport"]')!
            .getBoundingClientRect()
          const expected = Math.min(46, field.height * 0.14)
          return Array.from(
            document.querySelectorAll('[data-roster-target^="defense-"]')
          ).every(
            node => Math.abs(node.getBoundingClientRect().height - expected) < 1
          )
        },
        { timeout: 5000 }
      )
      const emptyGeometry = await page.evaluate(() => {
        const field = document
          .querySelector('[data-testid="Defensive field"]')!
          .getBoundingClientRect()
        return Array.from(
          document.querySelectorAll('[data-roster-target^="defense-"]')
        ).every(node => {
          const r = node.getBoundingClientRect()
          return r.y >= field.y && r.bottom <= field.bottom + 1
        })
      })
      expect(
        emptyGeometry,
        'all field targets fit while validation is visible'
      ).equals(true)
    }
    await click(page, 'Clear 2B')
    // The pitcher, back on the visitors' bench.
    const source = '[data-roster-target="roster"] [data-roster-player="101"]'
    const target = '[data-roster-target="defense-SS"]'
    const firstBase = await page.$eval(
      '[data-roster-target="defense-1B"]',
      node => node.textContent
    )
    await new Promise(resolve => setTimeout(resolve, 300))
    const point = async (selector: string): Promise<{ x: number; y: number }> =>
      await page.$eval(selector, node => {
        const r = node.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })
    const from = await point(source)
    const pitcher = await page.$eval(
      '[data-roster-target="defense-P"]',
      node => node.textContent
    )
    const to = await page.$eval(target, node => {
      const r = node.getBoundingClientRect()
      return { x: r.right - 24, y: r.bottom - 1 }
    })
    const clip = await page.$eval(
      '[data-testid="Defensive field viewport"]',
      node => {
        const r = node.getBoundingClientRect()
        return { top: r.top, height: r.height }
      }
    )
    expect(to.y).within(clip.top, clip.top + clip.height)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await new Promise(resolve => setTimeout(resolve, 550))
    await page.waitForSelector('[data-testid="Roster dragged card"]', {
      timeout: 2000
    })

    await page.mouse.move(to.x, to.y)
    // Await the real hit preview before releasing, as a user sees the outlined position.
    await page.waitForFunction(
      selector =>
        document.querySelector<HTMLElement>(selector)!.style.outline !== '',
      {},
      target
    )
    await page.mouse.up()
    await new Promise(resolve => setTimeout(resolve, 300))
    // The pitcher now plays short.
    await page.waitForFunction(
      selector =>
        document.querySelector(selector)!.getAttribute('data-roster-player') ===
        '101',
      {},
      target
    )
    expect(
      await page.$eval(
        '[data-testid="Defense SS card"]',
        node => getComputedStyle(node).borderTopStyle
      )
    ).equals('solid')
    expect(
      await page.$eval(
        '[data-testid="Defense SS card"]',
        node => getComputedStyle(node).backgroundColor
      )
    ).equals(cssColor(scoringSurface.active))
    expect(
      await page.$eval(
        '[data-roster-target="defense-1B"]',
        node => node.textContent
      )
    ).equals(firstBase)
    expect(
      await page.$eval(
        '[data-roster-target="defense-P"]',
        node => node.textContent
      )
    ).equals(pitcher)
    await page.$eval('[aria-label="Roster players"]', node => {
      node.scrollTop = 0
    })
    const available = await page.$eval(
      '[data-roster-target="roster"] [data-roster-player]',
      node => node.getAttribute('data-roster-player')!
    )
    const pitcherFrom = await point(
      `[data-roster-target="roster"] [data-roster-player="${available}"]`
    )
    const pitcherTo = await point('[data-roster-target="defense-P"]')
    await page.mouse.move(pitcherFrom.x, pitcherFrom.y)
    await page.mouse.down()
    await new Promise(resolve => setTimeout(resolve, 550))
    await page.mouse.move(pitcherTo.x, pitcherTo.y)
    await page.waitForSelector('[data-testid="Roster dragged card"]')
    await page.mouse.up()
    await page.waitForSelector('[aria-label="Clear P"]')
    await click(page, 'Save Rosters')
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await click(page, 'Defense')
    // Saved and opened again, the pitcher still plays short.
    expect(
      await page.$eval(target, node => node.getAttribute('data-roster-player'))
    ).equals('101')
    expect(
      await page.$eval(
        '[data-testid="Defense SS card"]',
        node => getComputedStyle(node).backgroundColor
      )
    ).equals(cssColor(scoringSurface.active))
  } finally {
    await page.close()
  }
})
it('pulses drag-ready rows and limits light feedback to valid entries', async function () {
  const { page } = await open('/games/g1/score')
  try {
    await page.setViewport({ width: 390, height: 844 })
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await click(page, 'Defense')
    await click(page, 'Clear P')
    const supported = await page.evaluate(() => {
      Reflect.set(window, 'gestureHaptics', [])
      const original =
        typeof navigator.vibrate === 'function'
          ? navigator.vibrate.bind(navigator)
          : undefined
      if (original == null) return false
      Object.defineProperty(navigator, 'vibrate', {
        configurable: true,
        value: (pattern: VibratePattern): boolean => {
          const calls = Reflect.get(
            window,
            'gestureHaptics'
          ) as VibratePattern[]
          calls.push(pattern)
          return original(pattern)
        }
      })
      return true
    })
    const calls = async (): Promise<number> =>
      await page.evaluate(
        () => (Reflect.get(window, 'gestureHaptics') as VibratePattern[]).length
      )
    const point = async (
      selector: string
    ): Promise<{ x: number; y: number; width: number }> =>
      await page.$eval(selector, node => {
        const r = node.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width }
      })
    const source = '[data-roster-target="roster"] [data-roster-player="101"]'
    const from = await point(source)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.waitForFunction(
      width => {
        const node = document.querySelector(
          '[data-testid="Roster dragged card"]'
        )
        const r = node == null ? null : node.getBoundingClientRect()
        return r != null && r.width > width * 1.025
      },
      { timeout: 3000 },
      from.width
    )
    const peak = await point('[data-testid="Roster dragged card"]')
    expect(peak.width / from.width).within(1.025, 1.061)
    if (supported) expect(await calls()).equals(1)
    await page.mouse.move(from.x + 20, from.y - 20)
    await page.waitForFunction(
      width =>
        Math.abs(
          document
            .querySelector('[data-testid="Roster dragged card"]')!
            .getBoundingClientRect().width - width
        ) < 1,
      {},
      from.width
    )
    const pitcher = await point('[data-roster-target="defense-P"]')
    const catcher = await point('[data-roster-target="defense-C"]')
    await page.mouse.move(pitcher.x, pitcher.y)
    await new Promise(resolve => setTimeout(resolve, 200))
    if (supported) expect(await calls()).equals(2)
    await page.mouse.move(pitcher.x + 1, pitcher.y)
    await page.mouse.move(pitcher.x + 2, pitcher.y)
    await new Promise(resolve => setTimeout(resolve, 250))
    if (supported) expect(await calls()).equals(2)
    await page.mouse.move(catcher.x, catcher.y)
    await new Promise(resolve => setTimeout(resolve, 200))
    if (supported) expect(await calls()).equals(3)
    await page.mouse.move(1, catcher.y)
    await new Promise(resolve => setTimeout(resolve, 200))
    if (supported) expect(await calls()).equals(3)
    await page.mouse.move(catcher.x, catcher.y)
    await new Promise(resolve => setTimeout(resolve, 200))
    if (supported) expect(await calls()).equals(4)
    await page.mouse.up()
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="Roster dragged card"]') == null
    )
    expect(await page.$(source)).equals(null)
    await click(page, 'Cancel')
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await click(page, 'Defense')
    await click(page, 'Clear P')
    await page.emulateMediaFeatures([
      { name: 'prefers-reduced-motion', value: 'reduce' }
    ])
    await new Promise(resolve => setTimeout(resolve, 250))
    const reducedFrom = await point(source)
    const before = await calls()
    await page.mouse.move(reducedFrom.x, reducedFrom.y)
    await page.mouse.down()
    await page.waitForSelector('[data-testid="Roster dragged card"]')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(
      (await point('[data-testid="Roster dragged card"]')).width /
        reducedFrom.width
    ).within(0.99, 1.01)
    if (supported) expect(await calls()).equals(before + 1)
    await page.mouse.up()
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="Roster dragged card"]') == null
    )
    await click(page, 'Cancel')
    await page.emulateMediaFeatures([
      { name: 'prefers-reduced-motion', value: 'no-preference' }
    ])
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    // Set Team Rosters opens on the roster; the order is on the lineup.
    await click(page, 'Lineup')
    await page.waitForFunction(() =>
      document
        .getAnimations()
        .every(animation => animation.playState !== 'running')
    )
    const lineupSource = '[data-roster-target^="lineup-"][data-roster-player]'
    const lineupFrom = await point(lineupSource)
    const lineupBefore = await calls()
    await page.mouse.move(lineupFrom.x, lineupFrom.y)
    await page.mouse.down()
    await page.waitForFunction(
      width => {
        const node = document.querySelector(
          '[data-testid="Roster dragged card"]'
        )
        return (
          node != null && node.getBoundingClientRect().width > width * 1.025
        )
      },
      { timeout: 3000 },
      lineupFrom.width
    )
    if (supported) expect(await calls()).equals(lineupBefore + 1)
    await page.mouse.move(lineupFrom.x + 20, lineupFrom.y - 20)
    await page.mouse.up()
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="Roster dragged card"]') == null
    )
  } finally {
    await page.close()
  }
})
it('fits narrow defense selectors and exposes the entire roster error', async function () {
  server.awayTeamName('Demo Northern Hawks')
  const { page } = await open('/games/g1/score')
  try {
    await page.setViewport({ width: 320, height: 400 })
    await overrideBases(page, [['First base', 'Player 2']])
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await click(page, 'Lineup')
    const removals = await page.$$eval('[aria-label^="Remove "]', nodes =>
      nodes
        .map(node => node.getAttribute('aria-label')!)
        .filter(label => label !== 'Remove Player 2')
    )
    for (const label of removals) await click(page, label)
    await click(page, 'Defense')
    await new Promise(resolve => setTimeout(resolve, 500))
    for (const width of [320, 390]) {
      await page.setViewport({ width, height: 400 })
      await new Promise(resolve => setTimeout(resolve, 500))
      const controls = await page.evaluate(() => {
        const r = (label: string): { x: number; right: number } => {
          const b = document
            .querySelector(`[aria-label="${label}"]`)!
            .getBoundingClientRect()
          return { x: b.x, right: b.right }
        }
        return ['Away Team', 'Home Team', 'Lineup', 'Defense'].map(r)
      })
      for (let i = 0; i < controls.length; i++) {
        expect(controls[i].x).at.least(16)
        expect(controls[i].right).at.most(width - 16 + 1)
        if (i > 0) expect(controls[i].x).at.least(controls[i - 1].right - 1)
      }
    }
    await click(page, 'Clear P')
    for (const viewport of [
      { width: 390, height: 400 },
      { width: 320, height: 238 }
    ]) {
      await page.setViewport(viewport)
      await page.waitForFunction(() => {
        const f = document
          .querySelector('[data-testid="Defensive field"]')!
          .getBoundingClientRect()
        return Array.from(
          document.querySelectorAll('[data-roster-target^="defense-"]')
        ).every(node => {
          const r = node.getBoundingClientRect()
          return r.y >= f.y && r.bottom <= f.bottom + 1
        })
      })
      const error = await page.$eval('[role="alert"]', node => ({
        text: node.textContent,
        width: node.clientWidth,
        scroll: node.scrollWidth,
        style: getComputedStyle(node).textOverflow
      }))
      expect(error.text).equals(
        'Choose a next batter in the lineup who is not already on base.'
      )
      expect(error.scroll).at.most(error.width + 1)
      expect(error.style).not.equals('ellipsis')
      expect(
        await page.$eval(
          '[aria-label="Cancel"]',
          node => node.getBoundingClientRect().bottom
        )
      ).at.most(viewport.height + 1)
    }
  } finally {
    server.awayTeamName(undefined)
    await page.close()
  }
})
it('uses the compact defensive field and advances player input with Enter', async function () {
  const { page, unexpected } = await open('/games/g1/score')
  try {
    await page.setViewport({ width: 390, height: 844 })
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    expect(await page.$$('[aria-label="Cancel"]')).length(1)
    expect(await page.$('[aria-label="Create Placeholder Player"]')).equals(
      null
    )
    await click(page, 'Defense')
    expect(await page.$$('[data-roster-target^="defense-"]')).length(9)
    await click(page, 'Clear P')
    const source = '[data-roster-target="roster"] [data-roster-player="101"]'
    const target = '[data-roster-target="defense-P"]'
    const point = async (selector: string): Promise<{ x: number; y: number }> =>
      await page.$eval(selector, node => {
        const box = node.getBoundingClientRect()
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      })
    const from = await point(source)
    const to = await point(target)
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await new Promise(resolve => setTimeout(resolve, 550))
    await page.mouse.move(to.x, to.y, { steps: 15 })
    await page.mouse.up()
    await page.waitForSelector('[aria-label="Clear P"]')
    expect(await page.$(source)).equals(null)
    await click(page, 'Clear P')
    await page.waitForSelector(source)
    await click(page, 'Cancel')
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await click(page, 'Defense')
    await page.waitForSelector('[aria-label="Clear P"]')
    // Players are made on the roster.
    await click(page, 'Roster')
    await click(page, 'Create Player')
    // A new player's sheet opens with nothing focused: the scorer taps
    // First Name, and Enter takes him through the rest.
    await page.click('[aria-label="First Name"]')
    await page.waitForFunction(
      () => document.activeElement!.getAttribute('aria-label') === 'First Name'
    )
    await page.keyboard.type('Alex')
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      () => document.activeElement!.getAttribute('aria-label') === 'Last Name'
    )
    await page.keyboard.type('Demo')
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      () =>
        document.activeElement!.getAttribute('aria-label') === 'Jersey Number'
    )
    await page.keyboard.type('42')
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      () =>
        document.activeElement!.getAttribute('aria-label') !== 'Jersey Number'
    )
    expect(await page.$('[aria-label="Create Placeholder Player"]')).not.equals(
      null
    )
    expect(unexpected).deep.equals([])
  } finally {
    await page.close()
  }
})
it('keeps inline override runners reachable above the pinned Apply action on a small phone', async function () {
  const { page, unexpected } = await open('/games/g1/score')
  try {
    await page.setViewport({ width: 375, height: 667, deviceScaleFactor: 1 })
    await tapSettled(page, 'Open scoring menu')
    await tapSettled(page, 'Overrides')
    expect(await page.$('[aria-label="Correct runners"]')).equals(null)
    const divider = await page.$eval('[aria-label="Inning"]', row => {
      const label = row.firstElementChild!.getBoundingClientRect()
      const value = row.lastElementChild!.getBoundingClientRect()
      const line = row.nextElementSibling!.getBoundingClientRect()
      return { left: line.left - label.left, right: line.right - value.right }
    })
    expect(Math.abs(divider.left)).lessThan(1)
    expect(Math.abs(divider.right)).lessThan(1)
    const apply = '[aria-label="Apply Override"]'
    await new Promise(resolve => setTimeout(resolve, 350))
    await page.waitForFunction(() =>
      document
        .getAnimations()
        .every(animation => animation.playState !== 'running')
    )
    const before = await page.$eval(apply, n => n.getBoundingClientRect().top)
    await page.$eval('[data-testid="Scoring sheet content"]', n => {
      n.scrollTop = n.scrollHeight
    })
    await page.waitForFunction(() => {
      const content = document.querySelector(
        '[data-testid="Scoring sheet content"]'
      )!
      content.scrollTop = content.scrollHeight
      const row = document
        .querySelector('[aria-label="Third base"]')!
        .getBoundingClientRect()
      const footer = document
        .querySelector('[data-testid="Scoring sheet footer"]')!
        .getBoundingClientRect()
      return row.bottom <= footer.top && row.top > 0
    })
    const after = await page.$eval(apply, n => n.getBoundingClientRect().top)
    expect(Math.abs(after - before)).lessThan(1)
    expect(after).lessThan(667)
    await tapSettled(page, 'Third base')
    await tapSettled(page, 'Choose Third base Player 2 #2')
    expect(
      await page.$eval('[aria-label="Third base"]', n => n.textContent)
    ).includes('Player 2')
    const out = artifactDir()
    if (out != null) {
      await mkdir(out, { recursive: true })
      await page.screenshot({ path: join(out, 'inline-runners-after.png') })
    }
    await tapSettled(page, 'Apply Override')
    await page.waitForSelector('[aria-label="Undo Override game state"]')
    expect(unexpected).deep.equals([])
  } finally {
    await page.close()
  }
})
it('fills the bottom safe area in every shared scoring modal', async function () {
  const { page, unexpected } = await open('/games/g1/score')
  try {
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
    const cdp = await page.createCDPSession()
    await cdp.send('Emulation.setSafeAreaInsetsOverride', {
      insets: { bottom: 34 }
    })
    for (const label of [
      'Overrides',
      'Settings',
      'End Half Inning',
      'Swap Home and Away'
    ]) {
      await tapSettled(page, 'Open scoring menu')
      await tapSettled(page, label)
      await new Promise(resolve => setTimeout(resolve, 350))
      await page.waitForFunction(() =>
        document
          .getAnimations()
          .every(animation => animation.playState !== 'running')
      )
      await page.locator('[data-testid="Scoring sheet"]').hover()
      const geometry = await page.$eval('[data-testid="Scoring sheet"]', n => {
        const rect = n.getBoundingClientRect()
        const style = getComputedStyle(n)
        return {
          bottom: rect.bottom,
          padding: parseFloat(style.paddingBottom),
          border: style.borderBottomWidth,
          left: style.borderLeftWidth,
          right: style.borderRightWidth
        }
      })
      expect(geometry.bottom, label).equals(844)
      expect(geometry.padding, label).equals(50)
      expect(geometry.border, label).equals('0px')
      expect(geometry.left, label).equals('1px')
      expect(geometry.right, label).equals('1px')
      if (label === 'End Half Inning' || label === 'Swap Home and Away') {
        const gap = await page.$eval(
          '[data-testid="Scoring confirmation"]',
          n => {
            const description = n.firstElementChild!.getBoundingClientRect()
            const action = n.lastElementChild!.getBoundingClientRect()
            return action.top - description.bottom
          }
        )
        expect(gap, `${label} confirmation spacing`).at.least(12)
      }
      const out = artifactDir()
      if (out != null)
        await page.screenshot({
          path: join(
            out,
            `${label.toLowerCase().replaceAll(' ', '-')}-safe-area-after.png`
          )
        })
      await tapSettled(page, label === 'Settings' ? 'Done' : 'Cancel')
      await page.waitForSelector('[data-testid="Scoring sheet"]', {
        hidden: true
      })
    }
    expect(unexpected).deep.equals([])
  } finally {
    await page.close()
  }
})
it('edits rosters with a captured drag, validates overrides, and uses slide-up settings', async function () {
  const { page, unexpected } = await open('/games/g1/score')
  try {
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await click(page, 'Lineup')
    await click(page, 'Remove Player 2')
    await page.waitForFunction(() =>
      document
        .getAnimations()
        .every(animation => animation.playState !== 'running')
    )
    const source = '[aria-label="Add Player 2 to Lineup"]'
    const target = '[data-roster-target="lineup-0"]'
    await page.$eval(source, node => {
      node.scrollIntoView({ block: 'center' })
    })
    const from = await page.$eval(source, node => {
      const rect = node.getBoundingClientRect()
      return { x: rect.x + 20, y: rect.y + 15 }
    })
    const to = await page.$eval(target, node => {
      const rect = node.getBoundingClientRect()
      return { x: rect.x + 20, y: rect.y + 15 }
    })
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await new Promise(resolve => setTimeout(resolve, 750))
    await page.waitForSelector('[data-testid="Roster dragged card"]')
    await page.mouse.move(to.x, to.y, { steps: 12 })
    await page.mouse.up()
    await page.waitForFunction(() =>
      document
        .querySelector('[data-roster-target="lineup-0"]')!
        .textContent!.includes('Player 2')
    )
    await click(page, 'Save Rosters')
    await page.waitForSelector('[aria-label="Undo Set team roster"]')
    await click(page, 'Open scoring menu')
    await click(page, 'Overrides')
    expect(await page.$('[aria-label="Balls 4"]')).equals(null)
    await click(page, 'Balls 2')
    await click(page, 'Apply Override')
    await page.waitForSelector('[aria-label*="2 balls 0 strikes"]')
    await click(page, 'Open scoring menu')
    await click(page, 'Settings')
    await click(page, 'Toggle switch-hitter help')
    await click(page, 'Reset shown count')
    await click(page, 'Done')
    await click(page, 'Undo Override game state')
    await click(page, 'Undo Set team roster')
    expect(unexpected).deep.equals([])
  } finally {
    await page.close()
  }
})
it('creates detailed players in a full-screen roster and cancels only the active sheet', async function () {
  const { page, unexpected } = await open('/games/g1/score')
  try {
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await click(page, 'Create Player')
    await page.locator('[aria-label="First Name"]').fill('Mookie')
    await page.locator('[aria-label="Last Name"]').fill('Betts')
    await page.locator('[aria-label="Jersey Number"]').fill('07')
    await click(page, 'Throws L')
    await click(page, 'Bats S')
    await click(page, 'Player position P')
    await click(page, 'Player position DH')
    await click(page, 'Save and Create Another Player')
    await page.waitForFunction(
      () =>
        document.activeElement!.getAttribute('aria-label') === 'First Name' &&
        (document.activeElement as HTMLInputElement).value === ''
    )
    expect(
      await page.$eval('[aria-label="Bats R"]', n =>
        n.getAttribute('aria-selected')
      )
    ).equals('true')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[aria-label="Create Player"]')
    expect(await page.$('[aria-label="First Name"]')).equals(null)
    // The roster draws the saved player a moment after the sheet goes.
    const added = await page.waitForSelector(
      '[aria-label="Add Mookie B to Lineup"]'
    )
    expect(await added!.evaluate(n => n.textContent)).includes('#07 Mookie B')
    await click(page, 'Home Team')
    expect(await page.$('[aria-label="Add Mookie B to Lineup"]')).equals(null)
    await click(page, 'Away Team')
    await click(page, 'Save Rosters')
    await click(page, 'Undo Set team roster')
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    // Undo takes him out of the game's order; the team player remains
    // persisted, on the bench.
    await click(page, 'Lineup')
    expect(await page.$('[aria-label="Reorder Mookie B"]')).equals(null)
    expect(await page.$('[aria-label="Add Mookie B to Lineup"]')).not.equals(
      null
    )
    await click(page, 'Cancel')
    expect(unexpected).deep.equals([])
  } finally {
    await page.close()
  }
})
it('adds selected placeholder batches, cancels, isolates teams and supports Save/Undo', async function () {
  const { page, unexpected } = await open('/games/g1/score')
  try {
    await page.setViewport({ width: 390, height: 844 })
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await openPlaceholderSheet(page)
    await page.waitForSelector('[aria-label="Number of placeholder players"]')
    await new Promise(resolve => setTimeout(resolve, 400))
    const cancels = await page.$$('[aria-label="Cancel"]')
    const cancelBox = await cancels.at(-1)!.boundingBox()
    await page.mouse.click(
      cancelBox!.x + cancelBox!.width / 2,
      cancelBox!.y + cancelBox!.height / 2
    )
    await page.waitForSelector('[aria-label="Number of placeholder players"]', {
      hidden: true
    })
    await new Promise(resolve => setTimeout(resolve, 400))
    // Players are made on the roster; the bench is on the lineup.
    const add = async (count: 1 | 16): Promise<void> => {
      await click(page, 'Roster')
      await addPlaceholders(page, count)
      await click(page, 'Lineup')
    }
    await add(1)
    await add(16)
    expect(await page.$('[aria-label="Add OWLS Q to Lineup"]')).not.equals(null)
    expect(
      await page.$$('[data-roster-target="roster"] [data-roster-player]')
    ).length(17)
    await click(page, 'Home Team')
    expect(await page.$('[aria-label="Add OWLS A to Lineup"]')).equals(null)
    await add(1)
    expect(await page.$('[aria-label="Add HAWKS A to Lineup"]')).not.equals(
      null
    )
    await click(page, 'Save Rosters')
    await click(page, 'Undo Set team roster')
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await click(page, 'Lineup')
    expect(
      await page.$$('[data-roster-target="roster"] [data-roster-player]')
    ).length(0)
    await add(1)
    await click(page, 'Cancel')
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await click(page, 'Lineup')
    expect(await page.$('[aria-label="Add OWLS A to Lineup"]')).equals(null)
    await click(page, 'Cancel')
    expect(unexpected).deep.equals([])
  } finally {
    await page.close()
  }
})
it('shows one lineup insertion line and numbered themed rows before dropping', async function () {
  const { page } = await open('/games/g1/score')
  try {
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await click(page, 'Lineup')
    await page.evaluate(async () => {
      await document.fonts.ready
    })
    await page.waitForFunction(() =>
      document
        .getAnimations()
        .every(
          animation =>
            animation.effect == null ||
            animation.effect.getComputedTiming().iterations === Infinity ||
            (!animation.pending && animation.playState !== 'running')
        )
    )
    await page.evaluate(() => {
      const trace: unknown[] = []
      ;(
        window as Window & { rosterAcceptanceTrace?: unknown[] }
      ).rosterAcceptanceTrace = trace
      for (const type of [
        'pointerdown',
        'pointermove',
        'pointerup',
        'pointercancel',
        'lostpointercapture'
      ])
        document.addEventListener(
          type,
          event => {
            const e = event as PointerEvent
            const row =
              e.target instanceof Element
                ? e.target.closest('[data-roster-target]')
                : null
            trace.push({
              type,
              at: performance.now(),
              x: e.clientX,
              y: e.clientY,
              buttons: e.buttons,
              row: row == null ? null : row.getAttribute('data-roster-target'),
              bounds: Array.from(
                document.querySelectorAll('[data-roster-target]')
              ).map(target => ({
                target: target.getAttribute('data-roster-target'),
                player: target.getAttribute('data-roster-player'),
                bounds: target.getBoundingClientRect().toJSON()
              }))
            })
          },
          true
        )
    })
    const position = async (
      selector: string,
      bottom = false
    ): Promise<{ x: number; y: number }> =>
      await page.$eval(
        selector,
        (n, bottom) => {
          const r = n.getBoundingClientRect()
          return { x: r.x + 20, y: bottom ? r.bottom - 8 : r.top + 8 }
        },
        bottom
      )
    // Wait for the slide-up sheet to settle before measuring drag coordinates.
    await page.locator('[aria-label="Reorder Jordan K."]').hover()
    // Picked up by its grip; the row's start holds its red X.
    const a = await page.$eval(
      '[aria-label="Reorder Jordan K."] [data-roster-grip]',
      n => {
        const r = n.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      }
    )
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await new Promise(resolve => setTimeout(resolve, 750))
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-roster-target="lineup-0"]')!
          .getBoundingClientRect().height < 1
    )
    // Measure the destination only once source collapse completes.
    const b = await position('[data-roster-target="lineup-2"]', true)
    await page.mouse.move(b.x, b.y, { steps: 10 })
    await page.waitForFunction(
      () => {
        const line = document.querySelector<HTMLElement>(
          '[aria-label="Lineup insertion point"]'
        )
        if (line == null) return false
        const parent = line.parentElement
        if (parent == null) return false
        return (
          parent.getAttribute('data-roster-target') === 'lineup-2' &&
          line.style.bottom === '-2px'
        )
      },
      { timeout: 20000 }
    )
    expect(await page.$$('[aria-label="Lineup insertion point"]')).length(1)
    expect(
      await page.$eval(
        '[data-roster-target="lineup-2"]',
        n => getComputedStyle(n).outlineStyle
      )
    ).equals('none')
    await page.mouse.up()
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-roster-target="lineup-2"]')!
          .getAttribute('data-roster-player') === '101',
      { timeout: 20000 }
    )
    expect(
      await page.$eval('[data-roster-target="lineup-2"]', n => n.textContent)
    ).includes('#00 Jordan K.')
    await click(page, 'Cancel')
    await click(page, 'More')
    await click(page, 'Put Batter on Base')
    const alignment = await page.evaluate(() => ({
      parent: document
        .querySelector('[aria-label="Put Batter on Base"]')!
        .getBoundingClientRect().top,
      child: document
        .querySelector('[aria-label="First"]')!
        .getBoundingClientRect().top
    }))
    expect(alignment.child).closeTo(alignment.parent, 1)
  } catch (error) {
    const directory = artifactDir() ?? artifactDir()
    await mkdir(directory, { recursive: true })
    const stem = join(directory, `roster-insertion-failure-${Date.now()}`)
    const detail = await page.evaluate(() => ({
      trace: (window as Window & { rosterAcceptanceTrace?: unknown[] })
        .rosterAcceptanceTrace,
      rows: Array.from(document.querySelectorAll('[data-roster-target]')).map(
        row => ({
          target: row.getAttribute('data-roster-target'),
          player: row.getAttribute('data-roster-player'),
          bounds: row.getBoundingClientRect().toJSON(),
          text: row.textContent
        })
      ),
      animations: document.getAnimations().map(animation => ({
        state: animation.playState,
        pending: animation.pending
      })),
      lines: Array.from(
        document.querySelectorAll('[aria-label="Lineup insertion point"]')
      ).map(line => line.getBoundingClientRect().toJSON())
    }))
    await writeFile(stem + '.json', JSON.stringify(detail, null, 2))
    await page.screenshot({ path: stem + '.png' })
    console.error('Insertion failure diagnostics:', stem)
    throw error
  } finally {
    await page.close()
  }
})
it('appends tapped names, reorders after a hold, drags both selectors, and auto-scrolls the lineup', async function () {
  const { page, unexpected } = await open('/games/g1/score')
  try {
    await page.setViewport({
      width: 390,
      height: 740,
      isMobile: true,
      hasTouch: true
    })
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await click(page, 'Lineup')
    const center = async (
      selector: string
    ): Promise<{ x: number; y: number }> =>
      await page.$eval(selector, node => {
        const r = node.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })
    const swipe = async (from: string, to: string): Promise<void> => {
      const a = await center(from)
      const b = await center(to)
      await page.touchscreen.touchStart(a.x, a.y)
      await new Promise(resolve => setTimeout(resolve, 550))
      for (let i = 1; i <= 12; i++)
        await page.touchscreen.touchMove(
          a.x + ((b.x - a.x) * i) / 12,
          a.y + ((b.y - a.y) * i) / 12
        )
      await page.touchscreen.touchEnd()
    }
    await click(page, 'Remove Player 2')
    await click(page, 'Remove Player 3')
    await click(page, 'Add Player 3 to Lineup')
    await click(page, 'Add Player 2 to Lineup')
    expect(
      await page.$$eval(
        '[data-roster-target^="lineup-"][data-roster-player]',
        nodes => nodes.map(n => n.getAttribute('data-roster-player')).slice(-2)
      )
    ).deep.equals(['103', '102'])
    expect(await page.$$('[aria-label^="Move Player"]')).length(0)
    await swipe('[aria-label="Away Team"]', '[aria-label="Home Team"]')
    await page.waitForSelector('[aria-label="Home Team"][aria-selected="true"]')
    await swipe('[aria-label="Lineup"]', '[aria-label="Defense"]')
    await page.waitForSelector('[aria-label="Defense"][aria-selected="true"]')
    await click(page, 'Clear P')
    // A tap in defense never implies a slot; a direct drag replaces C.
    await click(page, 'Player 1')
    expect(
      await page.$eval('[data-roster-target="defense-P"]', n => n.textContent)
    ).includes('Unassigned')
    await swipe(
      '[data-roster-target="roster"] [data-roster-player="201"]',
      '[data-roster-target="defense-C"]'
    )
    await page.waitForFunction(() =>
      document
        .querySelector('[data-roster-target="defense-C"]')!
        .textContent!.includes('Player 1')
    )
    expect(
      await page.$('[data-roster-target="roster"] [data-roster-player="202"]')
    ).not.equals(null)
    await swipe('[aria-label="Home Team"]', '[aria-label="Away Team"]')
    await swipe('[aria-label="Defense"]', '[aria-label="Lineup"]')
    await page.waitForSelector('[aria-label="Lineup"][aria-selected="true"]')
    await page.$eval('[aria-label="Batting lineup"]', n => {
      n.scrollTop = 0
    })
    const from = await center('[aria-label="Drag Jordan K."]')
    const edge = await page.$eval('[aria-label="Batting lineup"]', n => {
      const r = n.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.bottom - 12 }
    })
    await page.touchscreen.touchStart(from.x, from.y)
    await new Promise(resolve => setTimeout(resolve, 550))
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-roster-target="lineup-0"]')!
          .getBoundingClientRect().height < 1
    )
    await page.touchscreen.touchMove(edge.x, edge.y)
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Batting lineup"]')!.scrollTop > 40
    )
    await page.touchscreen.touchEnd()
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-roster-target="lineup-0"]')!
          .getAttribute('data-roster-player') !== '1'
    )
    if (artifactDir() != null)
      await page.screenshot({
        path: `${artifactDir()}/roster-slider-drag.png`
      })
    await click(page, 'Cancel')
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await click(page, 'Lineup')
    expect(
      await page.$eval('[data-roster-target="lineup-0"]', n =>
        n.getAttribute('data-roster-player')
      )
    ).equals('101')
    expect(unexpected).deep.equals([])
  } finally {
    await page.close()
  }
})
it('cancels only the keyboard roster grab on Escape and retains prior draft edits', async function () {
  const { page } = await open('/games/g1/score')
  try {
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await click(page, 'Lineup')
    await click(page, 'Remove Player 2')
    await click(page, 'Remove Player 3')
    await click(page, 'Add Player 3 to Lineup')
    await click(page, 'Add Player 2 to Lineup')
    await page.focus('[aria-label="Reorder Jordan K."]')
    for (const key of ['Space', 'ArrowDown', 'ArrowDown', 'Enter'])
      await page.keyboard.press(key as 'Space' | 'ArrowDown' | 'Enter')
    const order = async (): Promise<Array<string | null>> =>
      await page.$$eval(
        '[data-roster-target^="lineup-"][data-roster-player]',
        nodes => nodes.map(n => n.getAttribute('data-roster-player'))
      )
    const before = await order()
    expect(before.slice(0, 3)).deep.equals(['104', '105', '101'])
    expect(before.slice(-2)).deep.equals(['103', '102'])
    await page.keyboard.press('Space')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[aria-label="Save Rosters"]')
    expect(await order()).deep.equals(before)
    await click(page, 'Save Rosters')
    await page.waitForSelector('[aria-label="Undo Set team roster"]')
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await click(page, 'Lineup')
    expect(await order()).deep.equals(before)
    await page.waitForSelector('[role="dialog"]')
    await page.focus('[aria-label="Reorder Jordan K."]')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[aria-label="Save Rosters"]', {
      hidden: true
    })
    expect(await page.$('[aria-label="Save Rosters"]')).equals(null)
  } finally {
    await page.close()
  }
})
it('scrolls roster and lineup rows before the hold and adds only after a held drop', async function () {
  const { page } = await open('/games/g1/score')
  try {
    await page.setViewport({
      width: 390,
      height: 740,
      isMobile: true,
      hasTouch: true
    })
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await click(page, 'Lineup')
    await click(page, 'Remove Player 2')
    await addPlaceholders(page, 16)
    await page.waitForSelector('[role="dialog"]')
    // Placeholders are made on Roster; the rows to scroll are on Lineup.
    await click(page, 'Lineup')
    const order = async (): Promise<string[]> =>
      await page.$$eval(
        '[data-roster-target^="lineup-"][data-roster-player]',
        rows => rows.map(n => n.getAttribute('data-roster-player')!)
      )
    const before = await order()
    for (const [list, selector] of [
      [
        'Roster players',
        '[data-roster-target="roster"] [data-roster-player="102"]'
      ],
      ['Batting lineup', '[data-roster-target="lineup-1"]']
    ]) {
      // On the row's body: its grip at the start picks the card up.
      const from = await page.$eval(selector, n => {
        const r = n.getBoundingClientRect()
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
      })
      // Browser-timed touch input stays below the 500ms hold threshold even
      // when Node/CDP round trips are slow during a complete test batch.
      const input = await page.createCDPSession()
      await input.send('Input.synthesizeScrollGesture', {
        x: from.x,
        y: from.y,
        yDistance: -80,
        speed: 800,
        gestureSourceType: 'touch',
        preventFling: true
      })
      await input.detach()
      await page.waitForFunction(
        label =>
          document.querySelector(`[aria-label="${label}"]`)!.scrollTop > 20,
        {},
        list
      )
      expect(await order()).deep.equals(before)
    }
    await page.$$eval(
      '[aria-label="Roster players"], [aria-label="Batting lineup"]',
      rows => {
        rows.forEach(n => {
          n.scrollTop = 0
        })
      }
    )
    await new Promise(resolve => setTimeout(resolve, 300))
    const from = await page.$eval(
      '[data-roster-target="roster"] [data-roster-player="102"]',
      n => {
        const r = n.getBoundingClientRect()
        return { x: r.x + 20, y: r.y + 20 }
      }
    )
    const to = await page.$eval('[data-roster-target="lineup-1"]', n => {
      const r = n.getBoundingClientRect()
      return { x: r.x + 20, y: r.y + 6 }
    })
    await page.touchscreen.touchStart(from.x, from.y)
    await new Promise(resolve => setTimeout(resolve, 550))
    await page.waitForSelector('[data-testid="Roster dragged card"]')
    await page.touchscreen.touchMove(to.x, to.y)
    await page.touchscreen.touchEnd()
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-roster-target="lineup-1"]')!
          .getAttribute('data-roster-player') === '102'
    )
    expect(await order()).length(before.length + 1)
  } finally {
    await page.close()
  }
})
it('assigns a defender with a touch drag on a phone-sized sheet', async function () {
  const { page, unexpected } = await open('/games/g1/score')
  try {
    await page.setViewport({
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true
    })
    await click(page, 'Open scoring menu')
    await click(page, 'Set Team Rosters')
    await click(page, 'Defense')
    await click(page, 'Clear P')
    const source = '[data-roster-target="roster"] [data-roster-player="101"]'
    const target = '[data-roster-target="defense-P"]'
    const from = await page.$eval(source, node => {
      const rect = node.getBoundingClientRect()
      return { x: rect.x + 20, y: rect.y + 15 }
    })
    const to = await page.$eval(target, node => {
      const rect = node.getBoundingClientRect()
      return { x: rect.x + 20, y: rect.y + 15 }
    })
    await page.touchscreen.touchStart(from.x, from.y)
    await new Promise(resolve => setTimeout(resolve, 550))
    await page.touchscreen.touchMove(to.x, to.y)
    await page.touchscreen.touchEnd()
    await page.waitForFunction(() =>
      document
        .querySelector('[data-roster-target="defense-P"]')!
        .textContent!.includes('Jordan K.')
    )
    if (artifactDir() != null)
      await page.screenshot({
        path: `${artifactDir()}/rosters-phone.png`
      })
    await click(page, 'Save Rosters')
    await page.waitForSelector('[aria-label="Undo Set team roster"]')
    expect(unexpected).deep.equals([])
  } finally {
    await page.close()
  }
})
for (const out of ['Ball Caught', 'Ground Out'])
  it(`opens ${out} under one drag and returns to the right without a Back button`, async function () {
    const { page, unexpected } = await open('/games/g1/score')
    try {
      const center = async (label: string): Promise<{ x: number; y: number }> =>
        await page.$eval(`[aria-label="${label}"]`, node => {
          const r = node.getBoundingClientRect()
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
        })
      await page.waitForSelector('[aria-label="Swing in Play"]')
      const button = await center('Swing in Play')
      await page.mouse.move(button.x, button.y)
      await page.mouse.down()
      await page.mouse.move(button.x, button.y - 20, { steps: 3 })
      await page.waitForSelector('[aria-label="Batter Out"]')
      const parent = await center('Batter Out')
      await page.mouse.move(parent.x, parent.y, { steps: 3 })
      await page.waitForSelector('[aria-label="Ground Out"]')
      const right = await center('Single')
      await page.mouse.move(right.x, right.y, { steps: 3 })
      await page.waitForSelector('[aria-label="Ground Out"]', {
        hidden: true
      })
      await page.mouse.move(parent.x, parent.y, { steps: 3 })
      await page.waitForSelector('[aria-label="Ball Caught"]')
      const leaf = await center(out)
      await page.mouse.move(leaf.x, leaf.y, { steps: 8 })
      await page.mouse.up()
      await page.waitForSelector(
        '[aria-label^="Tap or drag a player to where the ball was fielded"]'
      )
      expect(await page.$('[aria-label="Back"]')).equals(null)
      await page.waitForSelector('canvas[data-field-ready="true"]')
      const field = fieldOf(page)
      await placeOffered(field)
      // Dragged down to 5°: a caught ball goes no lower than a line drive.
      await setTrajectory(field, 5)
      const angle = out === 'Ball Caught' ? '10° Line Drive' : '5° Ground Ball'
      await page.waitForSelector(`[aria-label="Undo ${angle}"]`)
      await click(page, `Undo ${angle}`)
      await page.waitForSelector(
        '[aria-label^="Drag up and down for ball trajectory."]'
      )
      expect(unexpected).deep.equals([])
    } finally {
      await page.close()
    }
  })

export default defineHarness({
  id: 'scoring/scoring-screen/rosters-and-defense',
  title: 'The defensive field, roster and lineup editing, and overrides',
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
  minutes: 60,
  guards: [],
  // Offline and stalled servers are set by the scenarios themselves.
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios
})
