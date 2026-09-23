import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { asRosterEntry, GameStationClient } from '../../common/api'
import { ThemeProvider } from '../theme/ThemeContext'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { scoringPreferences } from './scoringPreferences'
import { scoringPreferences as nativePreferences } from './scoringPreferences.native'
import { ScoringScreen } from './ScoringScreen'
import type { ScoringStateSource } from './scoringStateSource'

let root: Root | undefined
// Host replacement is limited to WebGL; controls, state and preferences are real.
// eslint-disable-next-line @typescript-eslint/unbound-method
const getContext = HTMLCanvasElement.prototype.getContext
async function unmount(): Promise<void> {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
}
async function mount(
  client: GameStationClient,
  source?: ScoringStateSource
): Promise<void> {
  await unmount()
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof getContext
  const node = document.createElement('div')
  document.body.appendChild(node)
  root = createRoot(node)
  await act(async () => {
    root?.render(
      <ThemeProvider>
        <ScoringScreen
          client={client}
          gameId="g1"
          userId="scorer"
          onExit={() => undefined}
          source={source}
        />
      </ThemeProvider>
    )
  })
}
async function click(label: string): Promise<void> {
  const element = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  expect(element, label).not.equals(null)
  await act(async () => {
    element?.click()
  })
}
function clientForSwitchHitter(): GameStationClient {
  const client = new GameStationClient({ baseUrl: '/api/v1' })
  client.game = async () => gameFixture
  client.roster = async team =>
    team === 'away'
      ? [
          asRosterEntry({
            userId: 'usr_jordan',
            shortName: 'Jordan K.',
            jersey: '00',
            positions: ['P'],
            isPlayer: true,
            role: 'member',
            bats: 'switch'
          })
        ]
      : []
  return client
}
afterEach(async function () {
  await unmount()
  HTMLCanvasElement.prototype.getContext = getContext
})
describe('local scoring controls', function () {
  it('uses the game identity, records pitches and rewinds count and pitch count', async function () {
    await mount(clientForSwitchHitter())
    expect(document.body.textContent).includes('Owls 0 · Hawks 0 · Top 1st')
    await click('OK')
    await click('Ball')
    await click('Called Strike')
    await click('Foul Ball')
    expect(document.body.textContent).includes(
      '1 balls 2 strikes 0 outs · Pitches 3'
    )
    await click('Undo Foul Ball')
    await click('Undo Called Strike')
    await click('Undo Ball')
    expect(document.body.textContent).includes(
      '0 balls 0 strikes 0 outs · Pitches 0'
    )
  })
  it('shows help three times per user/device, counts when shown, and honors disable/reset', async function () {
    const client = clientForSwitchHitter()
    for (let appearance = 1; appearance <= 3; appearance++) {
      await mount(client)
      expect(document.body.textContent).includes('Drag hitter to other box')
      expect((await scoringPreferences.read('scorer')).shown).equals(appearance)
      await click('OK')
      expect(document.querySelector('[aria-label="OK"]')).equals(null)
    }
    await mount(client)
    expect(document.querySelector('[aria-label="OK"]')).equals(null)
    await scoringPreferences.write('scorer', { help: false, shown: 0 })
    await mount(client)
    expect(document.querySelector('[aria-label="OK"]')).equals(null)
    await scoringPreferences.write('scorer', { help: true, shown: 0 })
    await mount(client)
    expect(document.querySelector('[aria-label="OK"]')).not.equals(null)
    await click('Ball')
    expect(document.querySelector('[aria-label="OK"]')).equals(null)
  })
  it('keeps real team names when roster reads fail and supports a failing replaceable source', async function () {
    const client = clientForSwitchHitter()
    client.roster = async () => {
      throw new Error('unavailable')
    }
    let fail = true
    const source: ScoringStateSource = {
      load: async (game, away, home) => {
        expect(away).deep.equals([])
        expect(home).deep.equals([])
        return createDevelopmentSession(game, away, home)
      },
      save: async () => {
        if (fail) throw new Error('offline')
      }
    }
    await mount(client, source)
    expect(document.body.textContent).includes('Owls 0 · Hawks 0')
    expect(document.querySelector('[aria-label="Retry saving"]')).not.equals(
      null
    )
    fail = false
    await click('Retry saving')
    expect(document.querySelector('[aria-label="Retry saving"]')).equals(null)
    await mount(client, {
      ...source,
      load: async () => {
        throw new Error('bad state')
      }
    })
    expect(document.body.textContent).includes('Game not found.')
  })
  it('runs the native preference adapter through its platform storage implementation', async function () {
    await nativePreferences.write('native-test', { help: false, shown: 2 })
    expect(await nativePreferences.read('native-test')).deep.equals({
      help: false,
      shown: 2
    })
  })
})
