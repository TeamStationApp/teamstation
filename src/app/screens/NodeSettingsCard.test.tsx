import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { TeamStationClient } from '../../common/api'
import {
  defaultNodeSettings,
  defaultSponsorSettings,
  type NodeSettings,
  type NodeSettingsSave
} from '../../common/nodeSettings'
import { mount, text as nativeText, unmount } from '../../test/gameFormDom'
import { SponsorSampleUpload as NativeSampleUpload } from '../sponsors/SponsorSampleUpload.native'
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

async function type(label: string, next: string): Promise<void> {
  const field = document.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`
  )
  if (field == null) throw new Error(`no field ${label}`)
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(field, next)
    field.dispatchEvent(new window.Event('input', { bubbles: true }))
    await delay()
  })
}
const buttonLabels = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[role="button"]')].map(
    node => node.getAttribute('aria-label') ?? node.textContent ?? ''
  )
const isDisabled = (label: string): boolean =>
  [...document.querySelectorAll<HTMLElement>('[role="button"]')]
    .find(
      node => (node.getAttribute('aria-label') ?? node.textContent) === label
    )
    ?.getAttribute('aria-disabled') === 'true'

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
    keys: Array<string | null>
    recover: () => void
    store: (settings: NodeSettings) => void
    /** The sample an upload, here or elsewhere, made the node's. */
    sample: (key: string) => void
  } {
    const saved: NodeSettings[] = []
    const keys: Array<string | null> = []
    let failing = fail
    let stored = structuredClone(defaultNodeSettings)
    const client = {
      nodeSettings: async () => {
        if (failing != null) throw failing
        return structuredClone(stored)
      },
      setNodeSettings: async (settings: NodeSettingsSave) => {
        saved.push(settings as NodeSettings)
        // The key is not a setting a save changes, nor is the sample but
        // to put the default clip back.
        const sent = structuredClone(settings)
        stored = {
          ...sent,
          jev: stored.jev,
          sponsors: {
            ...(sent.sponsors ?? stored.sponsors),
            sampleKey:
              sent.sponsors?.sampleKey === null
                ? null
                : stored.sponsors.sampleKey
          }
        }
        return structuredClone(stored)
      },
      setJevKey: async (apiKey: string) => {
        keys.push(apiKey)
        stored = { ...stored, jev: { configured: true } }
      },
      clearJevKey: async () => {
        keys.push(null)
        stored = { ...stored, jev: { configured: false } }
      }
    } as unknown as TeamStationClient
    return {
      client,
      saved,
      keys,
      recover: () => {
        failing = undefined
      },
      store: settings => {
        stored = structuredClone(settings)
      },
      sample: key => {
        stored = { ...stored, sponsors: { ...stored.sponsors, sampleKey: key } }
      }
    }
  }

  it('edits each distribution link separately, rejects bad products and clears the saved link on Reset', async () => {
    const server = fake()
    const settings = structuredClone(defaultNodeSettings)
    Reflect.deleteProperty(settings.distribution, 'iosAppStoreUrl')
    server.store(settings)
    await render(server.client)
    const product =
      'https://apps.apple.com/us/app/teamstation/id00042/?ref=website#store'
    const links = [
      [
        'Android/iOS Beta Builds',
        'betaBuildsUrl',
        'https://builds.example.test/beta'
      ],
      ['iOS TestFlight', 'appStoreUrl', 'https://testflight.example.test/app'],
      ['iOS App Store link', 'iosAppStoreUrl', product]
    ] as const
    for (const [label, key, value] of links) {
      expect(shown(label)).equals('Not set')
      await press(label + ': Not set')
      if (key === 'iosAppStoreUrl') {
        await type(label, 'https://example.test/app/id42')
        await press('Use')
        expect(text()).contains(
          'iOS App Store link must be an App Store product URL'
        )
        expect(shown(label)).equals('Not set')
      }
      await type(label, value)
      await press('Use')
      expect(shown(label)).equals(value)
    }
    await press('iOS App Store link: ' + product)
    await type('iOS App Store link', '')
    await press('Cancel')
    expect(shown('iOS App Store link')).equals(product)
    await press('Save')
    expect(server.saved.at(-1)?.distribution).deep.equals(
      Object.fromEntries(links.map(([, key, value]) => [key, value]))
    )
    await act(async () => {
      root!.unmount()
    })
    await render(server.client)
    expect(shown('iOS App Store link')).equals(product)
    await press('Reset to defaults')
    await press('Save')
    expect(server.saved.at(-1)?.distribution).deep.equals(
      defaultNodeSettings.distribution
    )
  })

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
      },
      distribution: defaultNodeSettings.distribution,
      jev: defaultNodeSettings.jev,
      sponsors: defaultNodeSettings.sponsors
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
    // No free text but the Jev key, and no range repeated on the rows.
    expect(
      [...document.querySelectorAll('input:not([type="file"])')].map(input =>
        input.getAttribute('aria-label')
      )
    ).deep.equals(['Jev API key'])
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
      setNodeSettings: async (settings: NodeSettingsSave) => {
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

  it('sets a Jev key, then replaces or removes it, never showing it', async function () {
    const server = fake()
    await render(server.client)
    expect(text().toLowerCase()).contains('jev ranking')
    expect(text()).contains('No key is set.')
    const field = document.querySelector<HTMLInputElement>(
      'input[aria-label="Jev API key"]'
    )
    expect(field?.type).equals('password')
    expect(buttonLabels()).contains('Set')
    expect(buttonLabels()).not.contains('Replace')
    expect(buttonLabels()).not.contains('Remove')
    // Nothing typed, nothing to set.
    expect(isDisabled('Set')).equals(true)
    await press('Set')
    expect(server.keys).deep.equals([])

    await type('Jev API key', '  ts-first-key  ')
    expect(isDisabled('Set')).equals(false)
    await press('Set')
    expect(server.keys).deep.equals(['ts-first-key'])
    expect(field?.value).equals('')
    expect(text()).contains('A key is set.')
    expect(buttonLabels()).not.contains('Set')
    expect(isDisabled('Replace')).equals(true)
    expect(text()).not.contains('ts-first-key')

    await type('Jev API key', 'ts-second-key')
    await press('Replace')
    expect(server.keys).deep.equals(['ts-first-key', 'ts-second-key'])

    // Save and Reset to defaults leave the key as it is.
    await press('Reset to defaults')
    expect(buttonLabels()).contains('Remove')
    await press('Save')
    expect(server.saved.at(-1)!.jev).deep.equals({ configured: true })
    expect(buttonLabels()).contains('Remove')

    await press('Remove')
    expect(server.keys.at(-1)).equals(null)
    expect(text()).contains('No key is set.')
    expect(buttonLabels()).contains('Set')
    expect(buttonLabels()).not.contains('Remove')
  })

  it('shows Replace and Remove for a key already set, and says why a change was refused', async function () {
    const server = fake()
    server.store({ ...defaultNodeSettings, jev: { configured: true } })
    Object.assign(server.client, {
      setJevKey: async () => {
        throw new Error('Only a node administrator can set the Jev key')
      },
      clearJevKey: async () => {
        // Not an Error: the card says its own words.
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'refused'
      }
    })
    await render(server.client)
    expect(buttonLabels()).contains('Replace')
    expect(buttonLabels()).contains('Remove')
    await type('Jev API key', 'ts-key')
    await press('Replace')
    expect(text()).contains('Only a node administrator can set the Jev key')
    // Typing again clears the message.
    await type('Jev API key', 'ts-key-2')
    expect(text()).not.contains('Only a node administrator')
    await press('Remove')
    expect(text()).contains('The Jev key could not be changed. Retry.')
    expect(buttonLabels()).contains('Remove')
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

  describe('U42 sponsor settings', function () {
    const LOGOS = [
      'Logo — single camera',
      'Logo — four-angle grid',
      'Logo — Apple TV',
      'Logo — portrait'
    ]
    const REELS = [
      'Reel — portrait, 1 or 2 cameras',
      'Reel — portrait, 3 cameras',
      'Reel — portrait, 4 cameras',
      'Reel — landscape, 1 camera',
      'Reel — landscape, 2 cameras',
      'Reel — landscape, 3 cameras',
      'Reel — landscape, 4 cameras'
    ]
    /** Each sponsor value the card shows, by its row's name. */
    const sponsorValues = (): Record<string, string> =>
      Object.fromEntries([
        ...LOGOS.flatMap(logo =>
          ['side margin', 'top margin', 'largest width', 'largest height'].map(
            row => [`${logo}: ${row}`, shown(`${logo}: ${row}`)]
          )
        ),
        ...REELS.flatMap(reel =>
          ['largest width', 'largest height'].map(row => [
            `${reel}: ${row}`,
            shown(`${reel}: ${row}`)
          ])
        )
      ])
    const defaults = (): Record<string, string> =>
      Object.fromEntries([
        ...LOGOS.flatMap(logo => [
          [`${logo}: side margin`, '5%'],
          [`${logo}: top margin`, '5%'],
          [`${logo}: largest width`, '25%'],
          [`${logo}: largest height`, '25%']
        ]),
        ...REELS.flatMap(reel => [
          [`${reel}: largest width`, '33⅓%'],
          [`${reel}: largest height`, '33⅓%']
        ])
      ])

    /** A card whose server stores uploads, and answers what it stored. */
    function uploading(answer?: Error): {
      server: ReturnType<typeof fake>
      uploads: Array<{ contentType: string; bytes: Uint8Array }>
    } {
      const server = fake()
      const uploads: Array<{ contentType: string; bytes: Uint8Array }> = []
      Object.assign(server.client, {
        uploadSponsorSample: async (contentType: string, bytes: Uint8Array) => {
          uploads.push({ contentType, bytes })
          if (answer != null) throw answer
          server.sample('sponsors/sample/2026-11-25-smd_up.mp4')
          return {
            ...defaultSponsorSettings,
            sampleKey: 'sponsors/sample/2026-11-25-smd_up.mp4'
          }
        }
      })
      return { server, uploads }
    }

    /** Chooses `file` in the sample's hidden chooser. */
    async function choose(file: {
      type: string
      size: number
      bytes: Uint8Array
    }): Promise<void> {
      const input = document.querySelector<HTMLInputElement>(
        'input[data-testid="sponsor-sample-input"]'
      )
      if (input == null) throw new Error('no sample chooser')
      expect(input.type).equals('file')
      expect(input.accept).equals('video/mp4,video/quicktime')
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: [
          {
            type: file.type,
            size: file.size,
            arrayBuffer: async () => file.bytes.buffer
          }
        ]
      })
      await act(async () => {
        input.dispatchEvent(new window.Event('change', { bubbles: true }))
        await delay()
      })
    }

    it('shows each logo and reel group at its default, and the default clip', async function () {
      await render(fake().client)
      expect(text().toLowerCase()).contains('sponsor settings')
      for (const group of [...LOGOS, ...REELS, 'Sample video'])
        expect(text()).contains(group)
      expect(sponsorValues()).deep.equals(defaults())
      expect(text()).contains('Default clip')
      expect(buttonLabels()).contains('Upload sample video')
    })

    it('shows stored values at their nearest stops, a stored third as 33⅓%, and an uploaded sample’s day', async function () {
      const server = fake()
      server.store({
        ...defaultNodeSettings,
        sponsors: {
          ...defaultSponsorSettings,
          logo: {
            ...defaultSponsorSettings.logo,
            grid: { side: 0.104, top: 0.02, maxWidth: 0.33, maxHeight: 0.18 }
          },
          reel: {
            ...defaultSponsorSettings.reel,
            landscape2: { maxWidth: 0.34, maxHeight: 0.62 }
          },
          sampleKey: 'sponsors/sample/2026-11-25-smd_up.mp4'
        }
      })
      await render(server.client)
      expect(shown('Logo — four-angle grid: side margin')).equals('10%')
      expect(shown('Logo — four-angle grid: top margin')).equals('2%')
      expect(shown('Logo — four-angle grid: largest width')).equals('35%')
      expect(shown('Logo — four-angle grid: largest height')).equals('20%')
      // 0.34 is nearer the third than 35%.
      expect(shown('Reel — landscape, 2 cameras: largest width')).equals('33⅓%')
      expect(shown('Reel — landscape, 2 cameras: largest height')).equals('60%')
      expect(text()).contains('Uploaded Nov 25, 2026')
      expect(text()).not.contains('Default clip')
    })

    it('marks the form changed on a wheel, and Save sends the new placements', async function () {
      const server = fake()
      await render(server.client)
      await press('Save')
      expect(text()).contains('Saved.')
      await pick('Logo — single camera: side margin', 'Side margin 10%')
      expect(text()).not.contains('Saved.')
      await pick(
        'Reel — landscape, 1 camera: largest width',
        'Largest width 25%'
      )
      await pick('Logo — portrait: largest height', 'Largest height 40%')
      expect(shown('Logo — single camera: side margin')).equals('10%')
      expect(shown('Reel — landscape, 1 camera: largest width')).equals('25%')
      await press('Save')
      const sponsors = server.saved.at(-1)!.sponsors
      expect(sponsors.logo.single).deep.equals({
        ...defaultSponsorSettings.logo.single,
        side: 0.1
      })
      expect(sponsors.logo.portrait.maxHeight).equals(0.4)
      expect(sponsors.reel.landscape1).deep.equals({
        maxWidth: 0.25,
        maxHeight: 1 / 3
      })
      // Every value left alone goes back as it was: a third stays a third.
      expect(sponsors.reel.portrait12).deep.equals({
        maxWidth: 1 / 3,
        maxHeight: 1 / 3
      })
      expect(sponsors.logo.grid).deep.equals(defaultSponsorSettings.logo.grid)
      expect(text()).contains('Saved.')
    })

    it('offers the third on the reel wheel and saves it back exactly', async function () {
      const server = fake()
      server.store({
        ...defaultNodeSettings,
        sponsors: {
          ...defaultSponsorSettings,
          reel: {
            ...defaultSponsorSettings.reel,
            landscape4: { maxWidth: 0.5, maxHeight: 0.5 }
          }
        }
      })
      await render(server.client)
      await pick(
        'Reel — landscape, 4 cameras: largest width',
        'Largest width 33⅓%'
      )
      expect(shown('Reel — landscape, 4 cameras: largest width')).equals('33⅓%')
      await press('Save')
      expect(server.saved.at(-1)!.sponsors.reel.landscape4).deep.equals({
        maxWidth: 1 / 3,
        maxHeight: 0.5
      })
    })

    it('puts every sponsor value and the default clip back on Reset to defaults, and saves exactly the defaults', async function () {
      const server = fake()
      server.store({
        ...defaultNodeSettings,
        sponsors: {
          ...defaultSponsorSettings,
          sampleKey: 'sponsors/sample/2026-11-25-smd_up.mp4'
        }
      })
      await render(server.client)
      await pick('Logo — Apple TV: top margin', 'Top margin 20%')
      await pick(
        'Reel — portrait, 3 cameras: largest height',
        'Largest height 75%'
      )
      expect(text()).contains('Uploaded Nov 25, 2026')
      await press('Reset to defaults')
      expect(sponsorValues()).deep.equals(defaults())
      expect(text()).contains('Default clip')
      await press('Save')
      const saved = server.saved.at(-1)!.sponsors
      expect(saved).deep.equals(defaultSponsorSettings)
      expect(saved.reel.landscape1.maxWidth).equals(1 / 3)
      expect(saved.sampleKey).equals(null)
      expect(shown('Reel — landscape, 1 camera: largest width')).equals('33⅓%')
    })

    it('uploads a chosen sample video on the web and shows its day, apart from Save', async function () {
      const { server, uploads } = uploading()
      await render(server.client)
      await choose({
        type: 'video/mp4',
        size: 4,
        bytes: new Uint8Array([0, 0, 0, 1])
      })
      expect(uploads).has.length(1)
      expect(uploads[0].contentType).equals('video/mp4')
      expect([...uploads[0].bytes]).deep.equals([0, 0, 0, 1])
      expect(text()).contains('Uploaded Nov 25, 2026')
      // Nothing else was saved with it.
      expect(server.saved).has.length(0)
      // A later Save sends no sample, and the new one stays.
      await press('Save')
      expect(server.saved.at(-1)!.sponsors).not.have.property('sampleKey')
      expect(text()).contains('Uploaded Nov 25, 2026')
    })

    it('keeps a sample uploaded elsewhere after the card was read, on a Save of something else', async function () {
      const server = fake()
      await render(server.client)
      expect(text()).contains('Default clip')
      // Another administrator's upload, after this card read the settings.
      server.sample('sponsors/sample/2026-11-25-smd_up.mp4')
      await pick('Logo — Apple TV: top margin', 'Top margin 20%')
      await press('Save')
      expect(server.saved.at(-1)!.sponsors).not.have.property('sampleKey')
      expect(text()).contains('Uploaded Nov 25, 2026')
    })

    it('says why a sample was refused, and refuses one past 120 MB without sending it', async function () {
      const { server, uploads } = uploading(
        new Error('The sample video must be 1,920 × 1,080.')
      )
      await render(server.client)
      await choose({ type: '', size: 4, bytes: new Uint8Array([1, 2, 3, 4]) })
      expect(uploads.map(upload => upload.contentType)).deep.equals([
        'video/mp4'
      ])
      expect(text()).contains('The sample video must be 1,920 × 1,080.')
      expect(text()).contains('Default clip')
      await choose({
        type: 'video/mp4',
        size: 130_000_000,
        bytes: new Uint8Array([1])
      })
      expect(uploads).has.length(1)
      expect(text()).contains('The sample video can be at most 120 MB.')
    })

    it('says on a phone to upload the sample video from the web', async function () {
      await mount(<NativeSampleUpload busy={false} onPick={() => undefined} />)
      expect(nativeText()).contains('Upload the sample video from the web.')
      await unmount()
    })
  })
})
