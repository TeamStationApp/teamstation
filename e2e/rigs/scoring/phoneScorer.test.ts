import { expect } from 'chai'
import { describe, it } from 'mocha'

import { newSetup } from '../../../src/common/scoring/lineup'
import {
  apiAs,
  centre,
  flatten,
  flick,
  heldDrag,
  keyboardShown,
  labelOf,
  openPhoneScorer,
  pointOf,
  proofOf,
  replayStored,
  scorePath,
  until
} from './phoneScorer'

/** A maestro-d device that records every command and answers `hierarchy`. */
function fakeDevice(tree: unknown = { children: [] }): {
  m: any
  steps: Array<[string, unknown]>
} {
  const steps: Array<[string, unknown]> = []
  const record =
    (name: string) =>
    async (options: unknown): Promise<void> => {
      steps.push([name, options])
    }
  const m: any = new Proxy(
    {},
    {
      get: (_target, name: string) => {
        if (name === 'then') return undefined
        if (name === 'hierarchy') return async () => tree
        if (name === 'assertVisible')
          return async (options: { text?: string }) => {
            steps.push(['assertVisible', options])
            // No "Open" prompt is shown.
            if (options.text === '^Open$') throw new Error('not shown')
          }
        return record(name)
      }
    }
  )
  return { m, steps }
}

function fakeCtx(surface: string, m: any): any {
  const signedIn: string[] = []
  const limits: unknown[] = []
  return {
    signedIn,
    limits,
    surface,
    stack: {
      origin: 'https://stack.example.test',
      control: {
        rateLimits: async (body: unknown) => {
          limits.push(body)
        }
      }
    },
    app: (kind: string) => `id-of-${kind}`,
    attached: () => m,
    mobileBrowser: async (_role: string, url: string) => {
      await m.openLink({ link: url, browser: true })
      return m
    },
    signIn: async (role: string) => {
      signedIn.push(role)
    }
  }
}

describe('phoneScorer', () => {
  it('reads nodes, labels, centres and points', () => {
    const tree = {
      text: 'root',
      children: [{ accessibilityText: 'Ball', children: [{ text: 'x' }] }]
    }
    expect(flatten(tree).map(labelOf)).to.deep.equal(['root', 'Ball', 'x'])
    expect(labelOf({})).to.equal('')
    expect(centre({ x: 10, y: 20, width: 4, height: 6 })).to.deep.equal({
      x: 12,
      y: 23
    })
    expect(pointOf({ x: 1.4, y: 2.6 })).to.equal('1,3')
    expect(scorePath('g 1')).to.equal('/games/g%201/score')
    expect(scorePath('g1', false)).to.equal('/games/g1')
  })

  it('opens the app on the stack, signs in and follows links', async () => {
    const { m, steps } = fakeDevice({
      children: [{ text: 'Open' }]
    })
    const ctx = fakeCtx('android-app', m)
    const app = await openPhoneScorer(ctx, 'scorer')
    expect(app.platform).to.equal('android')
    expect(app.browser).to.equal(false)
    expect(ctx.signedIn).to.deep.equal(['scorer'])
    expect(ctx.limits).to.have.length(1)
    expect(steps[0]).to.deep.equal([
      'launchApp',
      { appId: 'id-of-teamstation-android', clearState: true }
    ])
    await app.open('/games/g1/score')
    expect(steps).to.deep.include([
      'openLink',
      { link: 'teamstation://games/g1/score' }
    ])
    // The system's Open prompt is answered.
    expect(steps.at(-1)).to.deep.equal(['tapOn', { text: '^Open$' }])
    expect((await app.nodes()).length).to.equal(2)
  })

  it('opens the phone browser on the sign-in page', async () => {
    const { m, steps } = fakeDevice()
    const ctx = fakeCtx('web-safari-ios', m)
    const app = await openPhoneScorer(ctx, 'scorer')
    expect(app.platform).to.equal('ios')
    expect(app.browser).to.equal(true)
    expect(steps[0]).to.deep.equal([
      'openLink',
      { link: 'https://stack.example.test/sign-in', browser: true }
    ])
    await app.open('/games/g1/score')
    expect(steps.at(-1)).to.deep.equal([
      'openLink',
      { link: 'https://stack.example.test/games/g1/score', browser: true }
    ])
  })

  it('refuses a surface that is not a phone', async () => {
    const { m } = fakeDevice()
    let error: unknown
    try {
      await openPhoneScorer(fakeCtx('web-chromium', m), 'scorer')
    } catch (caught) {
      error = caught
    }
    expect(String(error)).to.include('not a phone surface')
  })

  it('drags, flicks and reads the keyboard through maestro-d', async () => {
    const { m, steps } = fakeDevice()
    await heldDrag(m, { x: 1, y: 2 }, { x: 3.6, y: 4 })
    await flick(m, 5, 100, 20)
    expect(steps).to.deep.equal([
      [
        'dragAndDrop',
        {
          from: { point: '1,2' },
          to: { point: '4,4' },
          holdDuration: 1000,
          duration: 1500
        }
      ],
      ['swipe', { start: '5,100', end: '5,20', duration: 250 }]
    ])
    expect(
      await keyboardShown({ keyboardVisible: async () => ({ visible: true }) })
    ).to.equal(true)
    expect(
      await keyboardShown({
        keyboardVisible: async () => ({ data: { visible: false } })
      })
    ).to.equal(false)
  })

  it('waits until a check holds, or fails naming it', async () => {
    let calls = 0
    await until(async () => ++calls === 2, 'never', 1000, 1)
    expect(calls).to.equal(2)
    let error: unknown
    try {
      await until(async () => false, 'it never held', 5, 1)
    } catch (caught) {
      error = caught
    }
    expect(String(error)).to.include('it never held')
  })

  it("signs in to the stack's API through the app's client", async () => {
    const ctx = fakeCtx('ios-app', fakeDevice().m)
    const made: unknown[] = []
    const api = await apiAs(
      ctx,
      { email: 'a@example.test', password: 'p' },
      async base => `token-for-${base}`,
      (base, token) => {
        made.push([base, token])
        return { base }
      }
    )
    expect(api.token).to.equal('token-for-https://stack.example.test/api/v1')
    expect(made).to.have.length(1)
    const real = await apiAs(
      ctx,
      { email: 'a@example.test', password: 'p' },
      async () => 'held'
    )
    expect(real.client.token).to.equal('held')
  })

  it('replays a stored game read-only and reads its proof', async () => {
    const teams = {
      away: { id: 'away', name: 'Owls' },
      home: { id: 'home', name: 'Hawks' }
    }
    const roster = (
      start: number
    ): Array<{ gumboId: number; shortName: string; jersey: string }> =>
      Array.from({ length: 9 }, (_, i) => ({
        gumboId: start + i,
        shortName: `Player ${i + 1}`,
        jersey: String(i + 1)
      }))
    const context = JSON.stringify({
      teams,
      setup: newSetup(teams, { away: roster(100), home: roster(200) })
    })
    const session = await replayStored(
      { plays: [], currentPlay: null },
      'g1',
      context
    )
    const proof = await proofOf(session)
    expect(proof.open).to.equal(false)
    expect(proof.bases).to.deep.equal([null, null, null])
    expect(proof.score).to.equal(0)
    let error: unknown
    try {
      await session.store.save('g1', {})
    } catch (caught) {
      error = caught
    }
    expect(String(error)).to.include('saves nothing')
  })
})
