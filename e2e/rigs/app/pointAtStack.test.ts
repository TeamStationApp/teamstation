import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  appLink,
  openInApp,
  pointAtStack,
  SERVER_LINK_SETTLE_MS,
  serverLink,
  type StackDevice
} from './pointAtStack'

/** A device that records each command, and shows iOS's Open prompt when `asks`. */
function device(asks: boolean): { m: StackDevice; steps: unknown[] } {
  const steps: unknown[] = []
  const m: StackDevice = {
    launchApp: async options => steps.push(['launchApp', options]),
    stopApp: async options => steps.push(['stopApp', options]),
    openLink: async options => steps.push(['openLink', options]),
    tapOn: async options => steps.push(['tapOn', options]),
    assertVisible: async options => {
      steps.push(['assertVisible', options])
      if (options.text === '^Open$' && !asks) throw new Error('not visible')
    }
  }
  return { m, steps }
}

describe('pointAtStack', function () {
  it('writes the develop build’s server and page links', function () {
    expect(serverLink('https://e2e-03.example.test')).equals(
      'teamstation-develop://server?origin=https%3A%2F%2Fe2e-03.example.test'
    )
    expect(serverLink(null)).equals('teamstation-develop://server?clear=1')
    expect(appLink('/groups/league/x/scheduler')).equals(
      'teamstation-develop://groups/league/x/scheduler'
    )
  })

  it('points a stopped app at the stack and launches it fresh, waiting on no notice', async function () {
    const { m, steps } = device(false)
    const started = Date.now()
    await pointAtStack(
      m,
      'https://e2e-03.example.test',
      'app.example.develop',
      20
    )
    expect(Date.now() - started).at.least(15)
    expect(steps).deep.equals([
      ['stopApp', { appId: 'app.example.develop' }],
      [
        'openLink',
        {
          link: 'teamstation-develop://server?origin=https%3A%2F%2Fe2e-03.example.test'
        }
      ],
      ['assertVisible', { text: '^Open$', timeout: 2500 }],
      ['launchApp', { appId: 'app.example.develop', stopApp: true }]
    ])
    // The "Restart TeamStation" notice is never looked for: it may be gone.
    expect(JSON.stringify(steps)).does.not.contain('Restart TeamStation')
    expect(SERVER_LINK_SETTLE_MS).equals(3000)
  })

  it('taps iOS’s Open when it asks before the app takes the link', async function () {
    const { m, steps } = device(true)
    await openInApp(m, 'app.example.develop', appLink('games/1'))
    expect(steps.slice(-2)).deep.equals([
      ['assertVisible', { text: '^Open$', timeout: 2500 }],
      ['tapOn', { text: '^Open$' }]
    ])
  })
})
