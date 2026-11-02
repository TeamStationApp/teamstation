import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { TeamStationClient } from '../../common/api'
import {
  defaultNodeSettings,
  type NodeSettings
} from '../../common/nodeSettings'
import { ThemeProvider } from '../theme/ThemeContext'
import {
  NodeAdministrationScreen,
  nodeAdministrationTiming
} from './NodeAdministrationScreen'
import { NodeSettingsCard, shownSettings } from './NodeSettingsCard'

let root: Root | undefined
const delay = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 15))
}
const text = (): string => document.body.textContent ?? ''
async function press(label: string): Promise<void> {
  const node = [
    ...document.querySelectorAll<HTMLElement>('[role="button"]')
  ].find(
    node => (node.getAttribute('aria-label') ?? node.textContent) === label
  )
  if (node == null) throw new Error(`no button ${label}`)
  await act(async () => {
    node.click()
    await delay()
  })
}
async function render(
  client: TeamStationClient,
  element: React.ReactElement = <NodeSettingsCard client={client} />
): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
    await delay()
  })
}
afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.innerHTML = ''
})

/** The value at the right of a row, by its section and label. */
function shown(name: string): string {
  const node = [
    ...document.querySelectorAll<HTMLElement>('[role="button"]')
  ].find(node =>
    (node.getAttribute('aria-label') ?? '').startsWith(`${name}: `)
  )
  if (node == null) throw new Error(`no row ${name}`)
  // The row says its label and value; its name is the section, label and
  // value, so the value is what follows the name.
  return (node.getAttribute('aria-label') ?? '').slice(name.length + 2)
}

/** Opens a row's wheel, taps `option` (the wheel's row) on it, and uses it. */
async function pick(name: string, option: string): Promise<void> {
  await press(`${name}: ${shown(name)}`)
  await press(option)
  await press('Use')
}

describe('NodeSettingsCard', function () {
  it('edits and saves both radar windows using the existing settings form', async () => {
    const api = fake()
    await render(api.client)
    expect(shown('Radar pitch window')).equals('3 s')
    expect(shown('Radar in-play window')).equals('15 s')
    await pick('Radar pitch window', 'Pitch window (before and after) 4 s')
    await pick('Radar in-play window', 'In-play lookback 20 s')
    await press('Save')
    expect(api.saved.at(-1)?.radar).deep.equals({
      pitchWindowSec: 4,
      inPlayWindowSec: 20
    })
  })
  function fake(fail?: Error): {
    client: TeamStationClient
    saved: NodeSettings[]
    recover: () => void
    store: (settings: NodeSettings) => void
  } {
    const saved: NodeSettings[] = []
    let failing = fail
    let stored = structuredClone(defaultNodeSettings)
    const client = {
      nodeSettings: async () => {
        if (failing != null) throw failing
        return structuredClone(stored)
      },
      setNodeSettings: async (settings: NodeSettings) => {
        saved.push(settings)
        stored = structuredClone(settings)
        return structuredClone(settings)
      }
    } as unknown as TeamStationClient
    return {
      client,
      saved,
      recover: () => {
        failing = undefined
      },
      store: settings => {
        stored = structuredClone(settings)
      }
    }
  }

  it('shows every value as a row, in percent and seconds, at the nearest stop', async function () {
    const server = fake()
    // Stored off the wheels' stops, as the server allows.
    server.store({
      radar: defaultNodeSettings.radar,
      replay: { pitchSec: 7 },
      scoreboard: {
        ...defaultNodeSettings.scoreboard,
        single: { x: 0.005, y: 0.005, height: 0.15 }
      },
      highlights: {
        ...defaultNodeSettings.highlights,
        leadSecByEventType: { strikeout: 10, walk: 90 }
      }
    })
    await render(server.client)
    expect(text().toLowerCase()).contains('scoreboard settings')
    expect(text().toLowerCase()).contains('highlights')
    expect(text()).not.contains('Node settings')
    expect(shown('Show for games from')).equals('2026-10-01')
    // 0.5% has no stop on a wheel of whole percents: it shows as 1%.
    expect(shown('Single camera: top')).equals('1%')
    expect(shown('Single camera: left')).equals('1%')
    expect(shown('Single camera: height')).equals('15%')
    expect(shown('Four-angle landscape: top')).equals('1%')
    expect(shown('Four-angle landscape: height')).equals('15%')
    expect(shown('Four-angle portrait: height')).equals('15%')
    expect(text()).not.contains('Four-angle portrait: top')
    expect(shown('Pitch speed display')).equals('5')
    expect(text().toLowerCase()).contains('replay')
    expect(shown('Replay pitch delay')).equals('7')
    expect(shown("Scorekeeper's tap lag")).equals('8 s')
    expect(shown('Rewind length: default')).equals('30 s')
    expect(shown('Rewind length: strikeout')).equals('10 s')
    // A play type's rewind beyond the wheel shows at its last stop.
    expect(shown('Rewind length: walk')).equals('60 s')
    expect(shown('Play past the event')).equals('5 s')
    // No free text, and no range repeated on the rows.
    expect(document.querySelector('input')).equals(null)
    expect(text()).not.contains('0–1')
  })

  it('sets each value on a wheel and saves them all, rounded as shown', async function () {
    const server = fake()
    server.store({
      ...defaultNodeSettings,
      highlights: {
        ...defaultNodeSettings.highlights,
        leadSecByEventType: { strikeout: 10, double: 12 },
        mergeWithinSec: 7
      }
    })
    await render(server.client)
    await pick('Single camera: top', 'Top 12%')
    await pick('Four-angle landscape: height', 'Height 25%')
    await pick('Four-angle TV: height', 'Height 10%')
    await pick('Four-angle portrait: height', 'Height 20%')
    await pick('Pitch speed display', 'Pitch speed display (seconds) 9')
    await pick('Replay pitch delay', 'Pitch delay (seconds) 7')
    await pick("Scorekeeper's tap lag", "Scorekeeper's tap lag 0 s")
    await pick('Rewind length: default', 'Default 45 s')
    await pick('Rewind length: walk', 'Walk 6 s')
    await pick('Rewind length: strikeout', 'Strikeout Default')
    await pick('Play past the event', 'Play past the event 8 s')
    expect(shown('Single camera: top')).equals('12%')
    expect(shown('Play past the event')).equals('8 s')
    expect(shown('Rewind length: strikeout')).equals('Default')
    await press('Save')
    const saved = server.saved.at(-1)!
    expect(saved.scoreboard).deep.equals({
      overlayStartDate: '2026-10-01',
      single: { x: 0.01, y: 0.12, height: 0.15 },
      landscape: { x: 0.01, y: 0.01, height: 0.25 },
      tvLandscape: { x: 0.01, y: 0.01, height: 0.1 },
      portraitHeight: 0.2,
      speedHoldSec: 9
    })
    expect(saved.replay).deep.equals({ pitchSec: 7 })
    expect(saved.highlights).deep.equals({
      lagSec: 0,
      leadSec: 45,
      // Strikeout back to the default; a play type the card does not offer
      // is kept as stored.
      leadSecByEventType: { double: 12, walk: 6 },
      mergeWithinSec: 7,
      tailSec: 8
    })
    expect(text()).contains('Saved.')
  })

  it('offers a pitch delay of 1 through 20 seconds, and keeps a stored one past it at its last stop', async function () {
    const server = fake()
    server.store({ ...defaultNodeSettings, replay: { pitchSec: 45 } })
    await render(server.client)
    expect(shown('Replay pitch delay')).equals('20')
    await press('Replay pitch delay: 20')
    const rows = [...document.querySelectorAll<HTMLElement>('[role="button"]')]
      .map(node => node.getAttribute('aria-label') ?? '')
      .filter(label => label.startsWith('Pitch delay (seconds) '))
    expect(rows[0]).equals('Pitch delay (seconds) 1')
    expect(rows.at(-1)).equals('Pitch delay (seconds) 20')
    expect(rows).length(20)
    await press('Cancel')
  })

  it('keeps the value it had when a wheel is cancelled', async function () {
    await render(fake().client)
    await press('Single camera: height: 15%')
    await press('Height 40%')
    await press('Cancel')
    expect(shown('Single camera: height')).equals('15%')
  })

  it('sets the start date on a calendar', async function () {
    const server = fake()
    await render(server.client)
    await press('Show for games from: 2026-10-01')
    await press('Choose 2026-10-15')
    await press('Use date')
    expect(shown('Show for games from')).equals('2026-10-15')
    await press('Save')
    expect(server.saved.at(-1)?.scoreboard.overlayStartDate).equals(
      '2026-10-15'
    )
  })

  it('colours every tappable value, and Reset to defaults, blue', async function () {
    await render(fake().client)
    // The innermost text that reads just so.
    const colour = (reads: string): string =>
      getComputedStyle(
        [...document.querySelectorAll('div')]
          .filter(node => node.textContent === reads)
          .at(-1)!
      ).color
    // tsBallpark's link blue (`linkTextColor`), #1565C0.
    const blue = 'rgb(21, 101, 192)'
    expect(colour('2026-10-01')).equals(blue)
    expect(colour('8 s')).equals(blue)
    expect(colour('Reset to defaults')).equals(blue)
    expect(colour('Pitch speed display (seconds)')).not.equals(blue)
  })

  it('keeps a play type it has no row for exactly as stored when another row is saved', async function () {
    const server = fake()
    server.store({
      ...defaultNodeSettings,
      highlights: {
        ...defaultNodeSettings.highlights,
        leadSecByEventType: { strikeout: 10, home_run: 120 }
      }
    })
    await render(server.client)
    expect(text()).not.contains('home_run')
    await pick('Single camera: height', 'Height 40%')
    await press('Save')
    expect(server.saved.at(-1)!.highlights.leadSecByEventType).deep.equals({
      strikeout: 10,
      home_run: 120
    })
  })

  it('puts the defaults back on Reset to defaults, to be saved', async function () {
    const server = fake()
    await render(server.client)
    await pick('Single camera: height', 'Height 40%')
    await pick('Replay pitch delay', 'Pitch delay (seconds) 12')
    await press('Reset to defaults')
    expect(shown('Single camera: height')).equals('15%')
    expect(shown('Replay pitch delay')).equals('5')
    await press('Save')
    // The defaults sit on the wheels' stops, so they are put back exactly.
    expect(shownSettings(defaultNodeSettings)).deep.equals(defaultNodeSettings)
    expect(server.saved.at(-1)).deep.equals(defaultNodeSettings)
  })

  it('is on the node administration screen, above the accounts', async function () {
    const { client } = fake()
    Object.assign(client, {
      nodeAccounts: async () => [],
      accountMail: async () => ({ accountMessages: false })
    })
    await render(
      client,
      <NodeAdministrationScreen client={client} onChanged={() => undefined} />
    )
    expect(text()).contains('Node administration')
    expect(text().toLowerCase()).contains('scoreboard settings')
    expect(shown('Show for games from')).equals('2026-10-01')
    // Above the accounts: their search and the node's access list.
    const all = text().toLowerCase()
    expect(all.indexOf('find an account')).greaterThan(-1)
    expect(all.indexOf('reset to defaults')).lessThan(
      all.indexOf('find an account')
    )
    expect(all.indexOf('reset to defaults')).lessThan(
      all.indexOf('node access')
    )
  })

  it('holds the accounts back until the settings above them have come', async function () {
    const { client } = fake()
    let arrive: () => void = () => {}
    const read = client.nodeSettings.bind(client)
    Object.assign(client, {
      nodeSettings: async () => {
        await new Promise<void>(resolve => {
          arrive = resolve
        })
        return await read()
      },
      nodeAccounts: async () => [],
      accountMail: async () => ({ accountMessages: false })
    })
    await render(
      client,
      <NodeAdministrationScreen client={client} onChanged={() => undefined} />
    )
    // The card's place is drawn, and nothing below it yet.
    expect(text()).contains("Loading the node's settings")
    expect(text().toLowerCase()).not.contains('find an account')
    await act(async () => {
      arrive()
      await delay()
    })
    expect(text()).not.contains("Loading the node's settings")
    expect(text().toLowerCase()).contains('find an account')
    expect(text().toLowerCase()).contains('node access')
  })

  it('lets the accounts through after a moment though the settings never come, and says an account failure at once', async function () {
    const was = nodeAdministrationTiming.settingsWaitMs
    nodeAdministrationTiming.settingsWaitMs = 60
    try {
      const { client } = fake()
      Object.assign(client, {
        // A read that stalls, and never answers.
        nodeSettings: async () => await new Promise<never>(() => {}),
        nodeAccounts: async () => [],
        accountMail: async () => ({ accountMessages: false }),
        setAccountMail: async () => {
          throw new Error('Account emails could not be changed. Retry.')
        }
      })
      await render(
        client,
        <NodeAdministrationScreen client={client} onChanged={() => undefined} />
      )
      expect(text().toLowerCase()).not.contains('find an account')
      // The emails switch fails while the accounts still wait: it is said.
      const toggle = document.querySelector<HTMLElement>(
        'input[type="checkbox"], [role="switch"]'
      )!
      await act(async () => {
        toggle.click()
        await delay()
      })
      expect(text()).contains('Account emails could not be changed. Retry.')
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 100))
      })
      expect(text().toLowerCase()).contains('find an account')
      expect(text().toLowerCase()).contains('node access')
      expect(text()).contains("Loading the node's settings")
    } finally {
      nodeAdministrationTiming.settingsWaitMs = was
    }
  })

  it('opens no picker while a save is on its way, so the save never undoes a newer choice', async function () {
    const server = fake()
    let answer: () => void = () => {}
    const write = server.client.setNodeSettings.bind(server.client)
    Object.assign(server.client, {
      setNodeSettings: async (settings: NodeSettings) => {
        await new Promise<void>(resolve => {
          answer = resolve
        })
        return await write(settings)
      }
    })
    await render(server.client)
    await pick('Single camera: height', 'Height 40%')
    await press('Save')
    // The row is shut while the save is out, and a tap opens nothing.
    await press(`Single camera: height: ${shown('Single camera: height')}`)
    expect(text()).not.contains('Use')
    await act(async () => {
      answer()
      await delay()
    })
    expect(text()).contains('Saved.')
    expect(shown('Single camera: height')).equals('40%')
    expect(server.saved.at(-1)!.scoreboard.single.height).equals(0.4)
  })

  it('says so when the settings cannot load, and loads them again on Retry', async function () {
    const server = fake(
      new Error('Only a node administrator can see the node settings')
    )
    await render(server.client)
    expect(text()).contains(
      'Only a node administrator can see the node settings'
    )
    server.recover()
    await press('Retry')
    expect(shown('Show for games from')).equals('2026-10-01')
  })

  it('says so when a save is refused', async function () {
    const server = fake()
    Object.assign(server.client, {
      setNodeSettings: async () => {
        throw new Error(
          'Only a node administrator can change the node settings'
        )
      }
    })
    await render(server.client)
    await press('Save')
    expect(text()).contains(
      'Only a node administrator can change the node settings'
    )
    expect(text()).not.contains('Saved.')
  })
})
