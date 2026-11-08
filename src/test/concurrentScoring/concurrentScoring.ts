/* eslint-disable @typescript-eslint/prefer-optional-chain -- Browser read probes cannot reference sucrase helper closures. */
import { writeFile } from 'node:fs/promises'

import { PerspectiveCamera, Vector3 } from 'three'

import { applyFieldCamera } from '../../app/field/cameraModel'
import { BASES } from '../../app/field/fieldModel'
import { TeamStationClient } from '../../common/api'
import { testPasswordKdf } from '../passwordFixtures'
import type { E2eContext, FixtureManifest, WebSession } from './context'

export interface ScoringClient {
  m: any
  page: WebSession['page'] | null
}

export class ConcurrentScoringRig {
  readonly clients: ScoringClient[] = []
  fixture!: FixtureManifest
  api!: TeamStationClient
  constructor(readonly ctx: E2eContext) {}

  protected async openClient(
    role: string,
    index: number
  ): Promise<ScoringClient> {
    const client = await this.ctx.browser(
      index === 2 ? { width: 1280, height: 900 } : { width: 393, height: 852 }
    )
    client.page.on('pageerror', error => {
      console.error(`Scoring client ${index} page error:`, error)
    })
    client.page.on('console', message => {
      if (message.type() === 'error')
        console.error(`Scoring client ${index} console error:`, message.text())
    })
    await client.m.openBrowser({ url: `${this.ctx.stack.origin}/sign-in` })
    await this.ctx.signIn(role, client.m)
    const path = index === 2 ? `coach/${this.fixture.ids.home}` : 'score'
    await client.m.openBrowser({
      url: `${this.ctx.stack.origin}/games/${this.fixture.ids.game}/${path}`
    })
    return client
  }

  async open(): Promise<void> {
    this.fixture = await this.ctx.fixture('concurrent-scoring')
    for (const [index, role] of ['scorer-a', 'scorer-b', 'coach'].entries()) {
      this.clients.push(await this.openClient(role, index))
    }
    this.api = new TeamStationClient({
      passwordKdf: testPasswordKdf,
      baseUrl: `${this.ctx.stack.origin}/api/v1`
    })
    const account = this.fixture.accounts['scorer-a']
    const signed = await this.api.signInWithPassword(
      account.email,
      account.password
    )
    this.api.token = signed.token
    const events = await this.api.gameEvents(this.fixture.ids.game)
    if (events.plays.length !== 0 || events.currentPlay != null)
      throw new Error('Acceptance requires a fresh unscored synthetic game')
  }

  async tap(index: number, text: string): Promise<void> {
    await this.clients[index].m.tapOn({ text, timeout: 10000 })
  }

  async text(index: number): Promise<string> {
    return await this.clients[index].page!.evaluate(
      () =>
        document.body.innerText +
        '\n' +
        [...document.querySelectorAll('[aria-label]')]
          .map(node => node.getAttribute('aria-label'))
          .join('\n')
    )
  }

  async capture(label: string): Promise<void> {
    for (const [i, client] of this.clients.entries()) {
      await writeFile(
        this.ctx.artifact(`${label}-${i}.png`),
        await client.m.screenshot()
      )
      await writeFile(
        this.ctx.artifact(`${label}-${i}.txt`),
        await this.text(i)
      )
    }
  }

  async expectText(
    index: number,
    expected: string,
    timeout = 3000
  ): Promise<void> {
    const end = Date.now() + timeout
    let actual = ''
    do {
      actual = await this.text(index)
      if (actual.includes(expected)) {
        await this.ctx.checkpoint(
          `client-${index}-${expected}`,
          {
            readBack: async () => {
              if (!(await this.text(index)).includes(expected))
                throw new Error(`Client ${index} lost ${expected}`)
            }
          },
          this.clients[index].m
        )
        return
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() < end)
    await this.capture('failed-convergence')
    await this.ctx.checkpoint(
      `client-${index}-convergence`,
      {
        readBack: async () => {
          throw new Error(
            `Client ${index} did not show ${JSON.stringify(expected)} within ${timeout}ms; actual: ${actual}`
          )
        }
      },
      this.clients[index].m
    )
  }

  async finish(index: number): Promise<void> {
    // Third outs and awards can close themselves. The following boundary
    // assertion still requires the exact completed play in storage and UI.
    const finish = await this.clients[index].page!.evaluate(
      () => document.querySelector('[aria-label="Finish at-bat"]') != null
    )
    if (finish) await this.tap(index, '^Finish at-bat$')
  }

  async pitch(index: number, label: string): Promise<void> {
    const css = `[aria-label="${label}"]:not([aria-disabled="true"]):not(:disabled)`
    await this.clients[index].m.assertVisible({ css, timeout: 15000 })
    await this.clients[index].m.tapOn({ css, timeout: 15000 })
    await this.converge(index, label)
  }

  async converge(author: number, action: string): Promise<void> {
    const started = Date.now()
    let expected = ''
    let actual = ''
    do {
      ;[expected, actual] = await Promise.all([
        this.summary(author),
        this.summary(1 - author)
      ])
      if (expected !== '' && expected === actual) break
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() - started < 3000)
    const elapsed = Date.now() - started
    await this.ctx.checkpoint(`sync-${author}-${action}-${elapsed}ms`, {
      readBack: async () => {
        if (elapsed > 3000)
          throw new Error(
            `Synchronization was not verified within three seconds after ${action} (${elapsed}ms); device transport time is included`
          )
        if (expected === '' || expected !== actual)
          throw new Error(
            `Three-second convergence failed after ${action}: ${expected} / ${actual}`
          )
      }
    })
  }

  async strikeout(index: number): Promise<void> {
    for (let i = 0; i < 3; i++) await this.pitch(index, 'Called Strike')
    await this.finish(index)
  }

  async hit(index: number, outcome: string, fielder?: number): Promise<void> {
    const m = this.clients[index].m
    await this.pitch(index, 'Swing in Play')
    await this.tap(index, `^${outcome}$`)
    if (fielder == null) {
      await m.tapOn({ css: '[role="application"]' })
      for (const key of ['Space', 'arrow_up', 'Enter', 'Enter'])
        await m.pressKey({ key })
    } else {
      await this.defender(index, fielder)
      await this.trajectory(index)
    }
  }

  async trajectory(index: number): Promise<void> {
    // Undo leaves keyboard focus on its button. Enter there would undo a
    // second step instead of accepting the restored trajectory.
    const client = this.clients[index]
    let focused = false
    for (let step = 0; step < 40; step++) {
      focused = await client.page!.evaluate(
        () =>
          document.activeElement != null &&
          document.activeElement.getAttribute('role') === 'application'
      )
      if (focused) break
      await client.m.pressKey({ key: 'Tab' })
    }
    if (!focused) throw new Error('Keyboard navigation did not reach the field')
    await this.clients[index].m.pressKey({ key: 'Enter' })
  }

  async more(index: number, label: string): Promise<void> {
    await this.tap(index, '^More$')
    await this.tap(index, `^${label}$`)
  }

  async agree(author: number, expected: string): Promise<void> {
    await this.expectText(author, expected, 15000)
    await this.expectText(1 - author, expected)
  }

  async rosters(index: number): Promise<void> {
    await this.tap(index, '^Open scoring menu$')
    await this.tap(index, '^Set Team Rosters$')
    await this.tap(index, '^Home Team$')
    await this.tap(index, '^Lineup$')
  }

  async lineup(index: number): Promise<string[]> {
    return await this.clients[index].page!.evaluate(() =>
      [...document.querySelectorAll('[aria-label^="Reorder "]')].map(node =>
        node.getAttribute('aria-label')!
      )
    )
  }

  async reorder(index: number, source: number, target: number): Promise<void> {
    await this.clients[index].m.dragAndDrop({
      from: { css: `[data-roster-target="lineup-${source}"]` },
      to: { css: `[data-roster-target="lineup-${target}"]` },
      holdDuration: 800,
      duration: 800
    })
  }

  async expectLineup(index: number, expected: string[]): Promise<void> {
    const deadline = Date.now() + 3000
    let actual: string[] = []
    const samples: Array<{ elapsed: number; lineup: string[] }> = []
    do {
      actual = await this.lineup(index)
      samples.push({ elapsed: Date.now() - (deadline - 3000), lineup: actual })
      if (JSON.stringify(actual) === JSON.stringify(expected)) break
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
    const observedAt = Date.now()
    await writeFile(
      this.ctx.artifact(`lineup-${index}-${observedAt}.json`),
      JSON.stringify({ expected, samples }, null, 2)
    )
    await this.ctx.checkpoint(
      `lineup-client-${index}`,
      {
        readBack: async () => {
          if (observedAt > deadline)
            throw new Error(
              `Client ${index}: lineup was not verified within three seconds`
            )
          if (JSON.stringify(actual) !== JSON.stringify(expected))
            throw new Error(
              `Client ${index}: expected lineup ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
            )
          const current = await this.lineup(index)
          if (JSON.stringify(current) !== JSON.stringify(expected))
            throw new Error(`Client ${index} lost the acknowledged lineup`)
        }
      },
      this.clients[index].m
    )
  }

  async summary(index: number): Promise<string> {
    return await this.clients[index].page!.evaluate(() => {
      const node = document.querySelector(
        '[aria-live="polite"][aria-label*=" · Batter "]'
      )
      if (node == null) return ''
      const label = node.getAttribute('aria-label')
      if (label == null) return ''
      return label
    })
  }

  async boundary(author: number, plays: number): Promise<void> {
    const deadline = Date.now() + 15000
    let events = await this.api.gameEvents(this.fixture.ids.game)
    while (events.plays.length !== plays && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
      events = await this.api.gameEvents(this.fixture.ids.game)
    }
    const expected = await this.summary(author)
    const until = Date.now() + 3000
    let actual = await this.summary(1 - author)
    while (actual !== expected && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 100))
      actual = await this.summary(1 - author)
    }
    const observedAt = Date.now()
    await this.ctx.checkpoint(
      `play-${plays}-scorer-state`,
      {
        readBack: async () => {
          if (observedAt > until)
            throw new Error(
              `Play ${plays}: scorer agreement was not verified within three seconds`
            )
          if (events.plays.length !== plays)
            throw new Error(
              `Expected ${plays} saved plays; got ${events.plays.length}`
            )
          if (expected === '' || actual !== expected)
            throw new Error(`Scorer states differ: ${expected} / ${actual}`)
          const current = await this.summary(1 - author)
          if (current !== expected)
            throw new Error(
              `Observer lost acknowledged state: ${expected} / ${current}`
            )
        }
      },
      this.clients[1 - author].m
    )
    await writeFile(
      this.ctx.artifact(`play-${plays}.json`),
      JSON.stringify({ expected, actual, events }, null, 2)
    )
  }

  async defender(index: number, jersey: number, base?: number): Promise<void> {
    const point = await this.clients[index].page!.evaluate(jersey => {
      const plate = [
        ...document.querySelectorAll('[data-nameplate^="defense-"]')
      ].find(node => {
        const number = node.querySelector('[data-line="number"]')
        return number != null && number.textContent === `#${jersey}`
      })
      if (plate == null) throw new Error(`Defender ${jersey} is not visible`)
      const r = plate.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    }, jersey)
    const from = `${Math.round(point.x)},${Math.round(point.y)}`
    if (base == null)
      await this.clients[index].m.tapOnPoint({
        x: Math.round(point.x),
        y: Math.round(point.y)
      })
    else {
      const rect = await this.clients[index].page!.evaluate(() => {
        const r = document.querySelector('canvas')!.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
      })
      const camera = new PerspectiveCamera()
      applyFieldCamera(camera, {
        width: rect.width,
        height: rect.height,
        view: 'home',
        zoom: 1.25,
        tilt: (-11 * Math.PI) / 180,
        heightOffset: 33,
        bottomExtension: 112
      })
      const p = new Vector3(BASES[base].x, 0, BASES[base].z).project(camera)
      const to = `${Math.round(rect.x + ((p.x + 1) * rect.width) / 2)},${Math.round(rect.y + ((1 - p.y) * rect.height) / 2)}`
      await this.clients[index].m.dragAndDrop({
        from: { point: from },
        to: { point: to },
        holdDuration: 200,
        duration: 800
      })
    }
  }

  async undo(index: number): Promise<void> {
    await this.clients[index].m.tapOn({
      css: '[aria-label^="Undo "]',
      timeout: 10000
    })
  }

  async undoAtBat(index: number): Promise<void> {
    // Reopen the saved play, then undo its scoring decisions through the
    // normal control until the pitch controls become available again.
    await this.undo(index)
    for (let step = 0; step < 8; step++) {
      const ready = await this.clients[index].page!.evaluate(
        () =>
          document.querySelector(
            '[aria-label="Swing in Play"]:not([aria-disabled="true"]):not(:disabled)'
          ) != null
      )
      if (ready) return
      await this.undo(index)
    }
    throw new Error('Undo did not restore the pitch controls')
  }

  async redoTrajectory(index: number, jersey: number): Promise<void> {
    for (let step = 0; step < 4; step++) {
      await this.undo(index)
      const text = await this.text(index)
      if (text.includes('Tap or drag a player to where the ball was fielded')) {
        await this.defender(index, jersey)
        await this.trajectory(index)
        return
      }
      if (text.includes('Drag up and down for ball trajectory')) {
        await this.trajectory(index)
        return
      }
    }
    throw new Error(
      'Undo did not restore the hit trajectory or fielder decision'
    )
  }

  async endGame(index: number): Promise<void> {
    await this.tap(index, '^Open scoring menu$')
    await this.tap(index, '^End Game$')
    await this.tap(index, '^Confirm End Game$')
    await this.agree(index, 'Game over')
  }

  async coachChange(): Promise<void> {
    await this.rosters(0)
    await this.rosters(1)
    await this.tap(2, '^Lineup$')
    const before = await this.lineup(2)
    await this.reorder(2, 3, 5)
    const changed = await this.lineup(2)
    if (JSON.stringify(before) === JSON.stringify(changed))
      throw new Error('Coach reorder made no change')
    await this.tap(2, '^Save Rosters$')
    await this.clients[2].m.assertVisible({
      css: '[aria-label="Save Rosters"][aria-disabled="true"]',
      timeout: 15000
    })
    await Promise.all([
      this.expectLineup(0, changed),
      this.expectLineup(1, changed)
    ])
    await this.capture(`coach-reorder-${Date.now()}`)
    await this.tap(0, '^Cancel$')
    await this.tap(1, '^Cancel$')
  }
}
