import { expect } from 'chai'
import { describe, it } from 'mocha'

import { BlockedError } from '../../core/result'
import type { E2eContext } from '../../core/spec'
import {
  clearSignInLimits,
  type CoachApp,
  defineCoachSpec,
  ERROR_PLAN,
  type Found,
  literal,
  savePlan,
  scrollTo,
  serverKeptOnHubPhone,
  stackSql,
  teamPath
} from './coachApp'

/** A context whose stack has these control routes, or none. */
function onStack(control?: Record<string, unknown>): E2eContext {
  return {
    stack: {
      origin: 'https://stack.example.test',
      ...(control == null ? {} : { control })
    }
  } as unknown as E2eContext
}

/** An app whose sheet moves up `step` points for each swipe it is given. */
function sheetApp(options: { web?: boolean; shareAt: number; step: number }): {
  app: CoachApp
  calls: Array<[string, unknown]>
} {
  const calls: Array<[string, unknown]> = []
  // Only whether there is a session matters to scrollTo, never what it holds.
  const session: unknown = {}
  let scrolled = 0
  const found = (id: string, x: number, y: number, width: number): Found => ({
    id,
    bounds: { x, y: y - scrolled, width, height: 44 },
    label: id
  })
  const screen = (): Found[] => [
    found('Plan scroll', 16, 209 + scrolled, 370),
    found('Plan cell 1-5', 316, 297, 28),
    found('Plan add inning', 344, 265, 28),
    found('Plan share', 82, options.shareAt, 117)
  ]
  const m = {
    swipe: async (swipe: unknown) => {
      calls.push(['swipe', swipe])
      scrolled += options.step
    },
    scrollUntilVisible: async (scroll: unknown) => {
      calls.push(['scrollUntilVisible', scroll])
    },
    waitForAnimationToEnd: async () => {}
  }
  return {
    calls,
    app: {
      m,
      web: options.web === true ? (session as CoachApp['web']) : undefined,
      nodes: async () => [],
      findAll: async pattern => screen().filter(each => pattern.test(each.id)),
      heroActions: async () => [],
      window: async () => ({ x: 0, y: 0, width: 402, height: 874 }),
      openGame: async () => {},
      openCoach: async () => {},
      openTeam: async () => {}
    }
  }
}

describe('the game plan rig', function () {
  it("points a hub phone at the stack the runner's way: the server link, the settle, a fresh launch, and no wait on a screen", async function () {
    const steps: string[] = []
    const m = {
      stopApp: async (o: { appId: string }) => steps.push(`stop ${o.appId}`),
      openLink: async (o: { link: string }) => steps.push(`link ${o.link}`),
      tapOn: async (o: { text: string }) => steps.push(`tap ${o.text}`),
      assertVisible: async (o: { text: string }) =>
        steps.push(`assert ${o.text}`),
      launchApp: async (o: { appId: string; stopApp?: boolean }) =>
        steps.push(`launch ${o.appId} stop=${String(o.stopApp)}`),
      extendedWaitUntil: async (o: { visible: { text: string } }) =>
        steps.push(`wait ${o.visible.text}`)
    }
    const started = Date.now()
    await serverKeptOnHubPhone(
      m,
      'app.example.develop',
      'https://stack.example.test',
      20
    )
    expect(Date.now() - started).greaterThanOrEqual(15)
    expect(steps).deep.equals([
      'stop app.example.develop',
      'link teamstation-develop://server?origin=https%3A%2F%2Fstack.example.test',
      'assert ^Open$',
      'tap ^Open$',
      'launch app.example.develop stop=true'
    ])
  })

  it("opens a team at its own page's address", function () {
    expect(teamPath('tem_home')).equals('/teams/tem_home')
    expect(teamPath('a b')).equals('/teams/a%20b')
  })

  it('matches a line literally, whatever it holds', function () {
    expect(literal('Inning 1 is missing: 3B, LF (and RF).')).equals(
      'Inning 1 is missing: 3B, LF \\(and RF\\)\\.'
    )
    expect(new RegExp(`^${literal('a+b*c?')}$`).test('a+b*c?')).equals(true)
  })

  it('swipes an app’s sheet up beside its last inning, as a share of the window, until the element is whole', async function () {
    const { app, calls } = sheetApp({ shareAt: 885, step: 140 })
    const share = await scrollTo(app, 'Plan share')
    expect(share.bounds.y).equals(745)
    expect(calls).to.have.length(1)
    // Between the add-inning column's right edge (372) and the scroll
    // view's (386): never on a cell, whose drag moves a player.
    const swipe = calls[0][1] as { start: string; end: string }
    expect(swipe.start).equals('94.3%, 70%')
    expect(swipe.end).equals('94.3%, 40%')
  })

  it('leaves an element already whole where it is', async function () {
    const { app, calls } = sheetApp({ shareAt: 600, step: 140 })
    expect((await scrollTo(app, 'Plan share')).bounds.y).equals(600)
    expect(calls).deep.equals([])
  })

  it('lets maestro-d scroll the web, and gives up on an element that never comes whole', async function () {
    const web = sheetApp({ web: true, shareAt: 600, step: 0 })
    await scrollTo(web.app, 'Plan share')
    expect(web.calls.map(([name]) => name)).deep.equals(['scrollUntilVisible'])
    const stuck = sheetApp({ shareAt: 900, step: 0 })
    let failure: unknown
    await scrollTo(stuck.app, 'Plan share').catch((error: unknown) => {
      failure = error
    })
    expect(String(failure)).includes('Plan share never came wholly into view')
    expect(stuck.calls).to.have.length(8)
  })

  it('runs setup SQL through the stack, and blocks a stack that cannot', async function () {
    let error: unknown
    try {
      await stackSql(onStack(), 'select 1')
    } catch (caught) {
      error = caught
    }
    expect(error).instanceOf(BlockedError)
    const asked: unknown[] = []
    const reply = await stackSql(
      onStack({
        sql: async (text: string, values: unknown[]) => {
          asked.push([text, values])
          return { rows: [{ one: 1 }], rowCount: 1 }
        }
      }),
      'select $1',
      [1]
    )
    expect(reply.rows).deep.equals([{ one: 1 }])
    expect(asked).deep.equals([['select $1', [1]]])
  })

  it('clears the password limits through the rateLimits control', async function () {
    let error: unknown
    try {
      await clearSignInLimits(onStack())
    } catch (caught) {
      error = caught
    }
    expect(error).instanceOf(BlockedError)
    const bodies: unknown[] = []
    await clearSignInLimits(
      onStack({
        rateLimits: async (body: unknown) => {
          bodies.push(body)
          return {}
        }
      })
    )
    expect(bodies).deep.equals([{ clear: ['password', 'passwordParameters'] }])
  })

  it("saves a world's plan as one row on the stack's database", async function () {
    const calls: unknown[][] = []
    const world = {
      nonce: 'n',
      ids: {
        game: 'gam_1',
        homeTeam: 'tem_1',
        ...Object.fromEntries(
          ERROR_PLAN.map((_, at) => [`homePlayer${at + 1}`, String(100 + at)])
        )
      },
      accounts: { coach: { userId: 'usr_c' } }
    } as any
    const sql = async (
      text: string,
      values: unknown[]
    ): Promise<{ rows: never[]; rowCount: number }> => {
      calls.push([text, values])
      return { rows: [], rowCount: calls.length === 1 ? 1 : 0 }
    }
    await savePlan(onStack({ sql }), world, ERROR_PLAN)
    const [text, values] = calls[0] as [string, unknown[]]
    expect(text).includes('insert into game_plans')
    expect(values.slice(0, 4)).deep.equals(['gam_1', 'tem_1', true, 5])
    expect(JSON.parse(values[4] as string)[0].player).deep.include({
      gumboId: 100,
      jersey: '1'
    })
    expect(values[5]).equals('usr_c')
    let error: unknown
    try {
      await savePlan(onStack({ sql }), world, ERROR_PLAN)
    } catch (caught) {
      error = caught
    }
    expect(String(error)).includes('the plan was not saved')
  })

  it('declares a coach spec on a GPU, a physical iPhone and the coach-game world', function () {
    const spec = defineCoachSpec({
      id: 'scoring/game-plan/x',
      title: 't',
      covers: ['src/app/scoring/plan/PlanTab.tsx'],
      minutes: 1,
      faults: [],
      scenarios: { a: async () => undefined }
    })
    expect(spec).to.include({ stack: 'isolated' })
    expect(spec.services).deep.equals([])
    expect(spec.fixtures).deep.equals(['coach-game'])
    expect(spec.surfaces['ios-app']?.devices).deep.equals([
      { role: 'device', needs: ['ios-phone', 'gpu'], simulator: 'never' }
    ])
    expect(spec.surfaces['web-chromium']?.browser?.needs).deep.equals(['gpu'])
  })
})
