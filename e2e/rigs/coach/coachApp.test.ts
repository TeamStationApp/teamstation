import { expect } from 'chai'
import { describe, it } from 'mocha'

import { type CoachApp, type Found, literal, scrollTo } from './coachApp'

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
      openCoach: async () => {}
    }
  }
}

describe('the game plan rig', function () {
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
})
