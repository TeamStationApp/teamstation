import { writeFile } from 'node:fs/promises'

import { TeamStationClient } from '../../src/common/api'
import { testPasswordKdf } from '../../src/test/passwordFixtures'
import type { FixtureManifest } from '../core/fixtures'
import type { E2eContext, WebSession } from '../core/spec'

export class ConcurrentScoringRig {
  readonly clients: WebSession[] = []
  fixture!: FixtureManifest
  api!: TeamStationClient
  constructor(readonly ctx: E2eContext) {}

  async open(): Promise<void> {
    this.fixture = await this.ctx.fixture('concurrent-scoring')
    for (const [index, role] of ['scorer-a', 'scorer-b', 'coach'].entries()) {
      const client = await this.ctx.browser(
        index === 2 ? { width: 1280, height: 900 } : { width: 393, height: 852 }
      )
      this.clients.push(client)
      await client.m.openBrowser({ url: `${this.ctx.stack.origin}/sign-in` })
      await this.ctx.signIn(role, client.m)
      const path = index === 2 ? `coach/${this.fixture.ids.home}` : 'score'
      await client.m.openBrowser({
        url: `${this.ctx.stack.origin}/games/${this.fixture.ids.game}/${path}`
      })
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
  }

  async tap(index: number, text: string): Promise<void> {
    await this.clients[index].m.tapOn({ text, timeout: 10000 })
  }

  async text(index: number): Promise<string> {
    return await this.clients[index].page.evaluate(
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
    await this.tap(index, '^Finish at-bat$')
  }

  async pitch(index: number, label: string): Promise<void> {
    await this.tap(index, `^${label}$`)
  }

  async strikeout(index: number): Promise<void> {
    for (let i = 0; i < 3; i++) await this.pitch(index, 'Called Strike')
    await this.finish(index)
  }

  async hit(index: number, outcome: string): Promise<void> {
    const m = this.clients[index].m
    await this.tap(index, '^Swing in Play$')
    await this.tap(index, `^${outcome}$`)
    await m.tapOn({ css: '[role="application"]' })
    for (const key of ['Space', 'arrow_up', 'Enter', 'Enter'])
      await m.pressKey({ key })
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
    return await this.clients[index].page.evaluate(() =>
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
    do {
      actual = await this.lineup(index)
      if (JSON.stringify(actual) === JSON.stringify(expected)) break
      await new Promise(resolve => setTimeout(resolve, 100))
    } while (Date.now() < deadline)
    await this.ctx.checkpoint(
      `lineup-client-${index}`,
      {
        readBack: async () => {
          if (JSON.stringify(actual) !== JSON.stringify(expected))
            throw new Error(
              `Client ${index}: expected lineup ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
            )
        }
      },
      this.clients[index].m
    )
  }

  async summary(index: number): Promise<string> {
    return await this.clients[index].page.evaluate(
      () =>
        document
          .querySelector('[aria-live="polite"][aria-label*=" · Batter "]')
          ?.getAttribute('aria-label') ?? ''
    )
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
    await this.ctx.checkpoint(
      `play-${plays}-three-client-state`,
      {
        readBack: async () => {
          if (events.plays.length !== plays)
            throw new Error(
              `Expected ${plays} saved plays; got ${events.plays.length}`
            )
          if (expected === '' || actual !== expected)
            throw new Error(`Scorer states differ: ${expected} / ${actual}`)
        }
      },
      this.clients[1 - author].m
    )
    await writeFile(
      this.ctx.artifact(`play-${plays}.json`),
      JSON.stringify({ expected, actual, events }, null, 2)
    )
  }
}
