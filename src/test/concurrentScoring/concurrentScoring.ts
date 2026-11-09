/* eslint-disable @typescript-eslint/prefer-optional-chain -- Browser read probes cannot reference sucrase helper closures. */
import { writeFile } from 'node:fs/promises'

import { PerspectiveCamera, Vector3 } from 'three'

import { applyFieldCamera } from '../../app/field/cameraModel'
import { BASES } from '../../app/field/fieldModel'
import { shortPlayerNames } from '../../app/scoring/currentSetup'
import { TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import { replayPlays } from '../../common/scoring/gumbo'
import { scoreboardOfGame } from '../../common/scoring/scoreboardOf'
import type { SessionContext, StoredGame } from '../../common/scoring/session'
import { startingSetup, teamsOf } from '../../common/scoring/startingSetup'
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
  savedContext!: SessionContext
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
    const game = await this.api.game(this.fixture.ids.game)
    const [away, home] = await Promise.all([
      this.api.roster(game.awayTeamId),
      this.api.roster(game.homeTeamId)
    ])
    this.savedContext = {
      gamePk: game.id,
      teams: teamsOf(game),
      setup: startingSetup(game, away, home),
      fenceDistanceFt: game.fenceDistanceFt
    }
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

  async pitch(index: number, label: string, completes = false): Promise<void> {
    const css = `[aria-label="${label}"]:not([aria-disabled="true"]):not(:disabled)`
    await this.clients[index].m.assertVisible({ css, timeout: 15000 })
    await this.clients[index].m.tapOn({ css, timeout: 15000 })
    if (!completes) await this.converge(index, label)
  }

  async converge(author: number, action: string): Promise<void> {
    // Device inspection is not network synchronization: allow three seconds,
    // then inspect once. Record its extra transport cost without counting it
    // as app latency or retrying a mismatched screen into a pass.
    await new Promise(resolve => setTimeout(resolve, 3000))
    const inspectedAt = Date.now()
    const [expected, actual] = await Promise.all([
      this.summary(author),
      this.summary(1 - author)
    ])
    await this.ctx.checkpoint(
      `sync-${author}-${action}-allowance3000ms-inspection${Date.now() - inspectedAt}ms`,
      {
        readBack: async () => {
          if (expected === '' || expected !== actual)
            throw new Error(
              `Scorer states differ after three seconds for ${action}: ${expected} / ${actual}`
            )
        }
      }
    )
  }

  async strikeout(index: number): Promise<void> {
    for (let i = 0; i < 2; i++) await this.pitch(index, 'Called Strike')
    // The caller's boundary verifies the saved completion after animation.
    await this.pitch(index, 'Called Strike', true)
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
    const page = this.clients[index].page
    if (page != null) {
      // A coordinate tap during the sheet's entrance can miss its tab.
      // Establish the intended view before the coach starts the timed save.
      const stable = await page.evaluate(async () => {
        let prior = ''
        let since = performance.now()
        const until = since + 3000
        while (performance.now() < until) {
          const tab = document.querySelector('[aria-label="Home Team"]')
          if (tab != null) {
            const rect = tab.getBoundingClientRect()
            const position = JSON.stringify([
              rect.x,
              rect.y,
              rect.width,
              rect.height
            ])
            if (position !== prior) {
              prior = position
              since = performance.now()
            } else if (performance.now() - since >= 200) return true
          }
          await new Promise<void>(resolve =>
            requestAnimationFrame(() => {
              resolve()
            })
          )
        }
        return false
      })
      if (!stable) throw new Error('Roster sheet did not finish opening')
    }
    await this.tap(index, '^Home Team$')
    if (page != null)
      await page.waitForSelector(
        '[aria-label="Home Team"][aria-selected="true"]',
        {
          timeout: 3000
        }
      )
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

  async expectLineup(
    index: number,
    expected: string[],
    acknowledgedAt = Date.now()
  ): Promise<void> {
    await new Promise(resolve =>
      setTimeout(resolve, Math.max(0, acknowledgedAt + 3000 - Date.now()))
    )
    const inspectionStarted = Date.now()
    const actual = await this.lineup(index)
    const observedAt = Date.now()
    await writeFile(
      this.ctx.artifact(`lineup-${index}-${observedAt}.json`),
      JSON.stringify(
        { expected, actual, acknowledgedAt, inspectionStarted, observedAt },
        null,
        2
      )
    )
    await this.ctx.checkpoint(
      `lineup-client-${index}`,
      {
        readBack: async () => {
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

  savedSummary(events: StoredGame): string {
    const { state, problems } = replayPlays(events, this.savedContext)
    if (problems.length !== 0)
      throw new Error(
        `Saved game cannot be replayed: ${JSON.stringify(problems)}`
      )
    const line = state.liveData.linescore
    const names = shortPlayerNames(Object.values(state.gameData.players))
    const name = (
      person: { id: number } | null | undefined,
      fallback: string
    ): string =>
      person == null ? fallback : (names.get(person.id) ?? fallback)
    const teams = state.gameData.teams
    return `${teams.away.name} ${line.teams.away.runs} · ${teams.home.name} ${line.teams.home.runs} · ${line.inningState} ${line.currentInningOrdinal} · ${line.balls} balls ${line.strikes} strikes ${line.outs} outs · Pitches ${scoreboardOfGame(state).numPitches} · Batter ${name(line.offense.batter, 'waiting')} ${state.liveData.plays.currentPlay?.matchup.batSide.code === 'L' ? 'left handed' : 'right handed'} · Pitcher ${name(line.defense.P, 'unassigned')}${(['first', 'second', 'third'] as const).map(base => ` · ${base} base ${name(line.offense[base], 'empty')}`).join('')}`
  }

  async boundary(author: number, plays: number): Promise<void> {
    const deadline = Date.now() + 15000
    // Undo retains the event row's identity while reopening its appearance.
    // That row does not count as completed until the current cursor advances.
    const completed = (events: StoredGame): number =>
      events.plays.filter(
        play => play.about.atBatIndex !== events.currentPlay?.about.atBatIndex
      ).length
    let retried = false
    const timedRead = async (): Promise<StoredGame> => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('Saved-game read deadline expired')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const events = await Promise.race([
          this.api.gameEvents(this.fixture.ids.game),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              reject(new Error('Saved-game read deadline expired'))
            }, remaining)
          })
        ])
        if (Date.now() >= deadline)
          throw new Error('Saved-game read deadline expired')
        return events
      } finally {
        clearTimeout(timer)
      }
    }
    const read = async (): ReturnType<TeamStationClient['gameEvents']> => {
      try {
        return await timedRead()
      } catch (error) {
        if (
          !(error instanceof HttpError) ||
          error.code !== 'offline' ||
          retried ||
          Date.now() + 100 >= deadline
        )
          throw error
        retried = true
        console.warn('Saved-game read lost its connection; retrying once')
        await new Promise(resolve => setTimeout(resolve, 100))
        return await timedRead()
      }
    }
    let events = await read()
    while (completed(events) !== plays && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
      events = await read()
    }
    await new Promise(resolve => setTimeout(resolve, 3000))
    // Undo can save several current-play revisions without changing the
    // completed count. Compare the screens with storage at inspection time,
    // not an intermediate revision seen while waiting for completion.
    const [latest, authored, actual] = await Promise.all([
      read(),
      this.summary(author),
      this.summary(1 - author)
    ])
    events = latest
    const expected = this.savedSummary(events)
    await writeFile(
      this.ctx.artifact(`play-${plays}.json`),
      JSON.stringify({ expected, authored, actual, events }, null, 2)
    )
    await this.ctx.checkpoint(
      `play-${plays}-scorer-state`,
      {
        readBack: async () => {
          if (completed(events) !== plays)
            throw new Error(
              `Expected ${plays} completed saved plays; got ${completed(events)}`
            )
          if (authored !== expected || actual !== expected)
            throw new Error(
              `Scorer states differ from saved game: ${expected} / ${authored} / ${actual}`
            )
          const current = await this.summary(1 - author)
          if (current !== expected)
            throw new Error(
              `Observer lost acknowledged state: ${expected} / ${current}`
            )
        }
      },
      this.clients[1 - author].m
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
    // Pointer release completes before the drag engine's asynchronous drop
    // and React render. Observe that local edit before pressing Save; this
    // does not extend the peer synchronization allowance after its response.
    await this.clients[2].page!.waitForFunction(
      previous =>
        JSON.stringify(
          [...document.querySelectorAll('[aria-label^="Reorder "]')].map(node =>
            node.getAttribute('aria-label')
          )
        ) !== previous,
      { timeout: 3000 },
      JSON.stringify(before)
    )
    const changed = await this.lineup(2)
    if (JSON.stringify(before) === JSON.stringify(changed))
      throw new Error('Coach reorder made no change')
    // The button disables optimistically. Time peer adoption from the actual
    // server acknowledgement, not from that optimistic local render.
    const saved = this.clients[2]
      .page!.waitForResponse(
        response =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname.endsWith(
            `/games/${this.fixture.ids.game}/lineups`
          )
      )
      .then(async response => {
        if (!response.ok())
          throw new Error(`Coach lineup save failed: ${response.status()}`)
        await response.json()
        return Date.now()
      })
    await this.tap(2, '^Save Rosters$')
    const acknowledgedAt = await saved
    await this.clients[2].m.assertVisible({
      css: '[aria-label="Save Rosters"][aria-disabled="true"]',
      timeout: 15000
    })
    await Promise.all([
      this.expectLineup(0, changed, acknowledgedAt),
      this.expectLineup(1, changed, acknowledgedAt)
    ])
    await this.capture(`coach-reorder-${Date.now()}`)
    await this.tap(0, '^Cancel$')
    await this.tap(1, '^Cancel$')
  }
}
