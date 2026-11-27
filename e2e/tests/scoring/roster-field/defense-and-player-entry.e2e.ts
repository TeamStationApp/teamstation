import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import {
  defineHarness,
  type HarnessContext,
  type SurfaceNeeds
} from '../../../core/spec'
import {
  type Bounds,
  centre,
  heldDrag,
  keyboardShown,
  labelOf,
  type Node,
  openPhoneScorer,
  type PhoneScorer,
  pointOf,
  scorePath,
  sleep
} from '../../../rigs/scoring/phoneScorer'

/**
 * The roster editor's defense and its player form on a phone, in the app
 * and in Safari: a held drag up to an empty position fills it and a tap on
 * the whole card clears it; a drop on a filled position replaces its
 * player; the draft survives team and mode switches; Save, reopen and Undo;
 * a lower roster card scrolled into view drags up to the field; Cancel
 * restores the defense; and Create Player takes first name, last name and
 * jersey one after another from the keyboard, Save and Create Another
 * resets and refocuses the form, and placeholders return to the roster.
 * The world's game has fourteen players a side (`roster-players`).
 */

/** A position action's label without the player it names. */
const label = (node: Node): string =>
  labelOf(node).replace(/^(Clear|Assign) ([^,]+),.*$/, '$1 $2')
const actionPattern = (text: string): string =>
  `^${text}${/^(Clear|Assign) /.test(text) ? '(?:, .*)?' : ''}$`

async function acceptance(ctx: HarnessContext): Promise<void> {
  const world = await ctx.fixture('roster-players')
  const app: PhoneScorer = await openPhoneScorer(ctx, 'scorer')
  const { m, platform, browser } = app
  const prefix = browser ? 'safari' : platform
  const lines: string[] = []
  const log = (line: string): void => {
    lines.push(line)
  }
  const all = async (): Promise<Node[]> => await app.nodes()
  const bounds = async (text: string): Promise<Bounds> => {
    const found = (await all())
      .filter(
        node =>
          label(node) === text &&
          node.visible !== false &&
          node.enabled !== false &&
          (node.bounds?.width ?? 0) > 0 &&
          (node.bounds?.height ?? 0) > 0
      )
      .sort(
        (a, b) =>
          (b.bounds?.width ?? 0) * (b.bounds?.height ?? 0) -
          (a.bounds?.width ?? 0) * (a.bounds?.height ?? 0)
      )[0]?.bounds
    expect(found, `${text} is visible`).to.not.equal(undefined)
    return found!
  }
  const noRosterCard = async (name: string): Promise<void> => {
    expect(
      !(await all()).some(
        node =>
          label(node) === name &&
          (node.bounds?.width ?? 0) >= 80 &&
          (node.bounds?.height ?? 0) >= 32
      ),
      `${name} left the roster grid`
    ).to.equal(true)
  }
  const tap = async (text: string): Promise<void> => {
    if (!browser) {
      const warning = (await all()).find(
        node =>
          label(node).includes('Open debugger to view warnings') &&
          node.bounds != null
      )
      if (warning?.bounds != null) {
        const b = warning.bounds
        await m.tapOn({
          point: pointOf({ x: b.x + b.width - 22, y: b.y + b.height / 2 })
        })
        await sleep(300)
      }
      await m.assertVisible({ text: actionPattern(text), timeout: 15000 })
      const first = await bounds(text)
      await sleep(500)
      const fresh = await bounds(text)
      expect(fresh, `${text} frame settled`).to.deep.equal(first)
      await m.tapOn({ point: pointOf(centre(fresh)) })
    } else
      await m.tapOn({
        text: actionPattern(text),
        enabled: true,
        timeout: 15000
      })
    await sleep(500)
  }
  const shot = async (name: string): Promise<void> => {
    await m.takeScreenshot({ path: ctx.artifact(`${prefix}-${name}.png`) })
    writeFileSync(
      ctx.artifact(`${prefix}-${name}-hierarchy.json`),
      JSON.stringify(await m.hierarchy(), null, 2)
    )
  }
  const drag = async (fromName: string, toName: string): Promise<void> => {
    await heldDrag(
      m,
      centre(await bounds(fromName)),
      centre(await bounds(toName))
    )
    await sleep(400)
  }
  /** Whether a field or text node on screen holds exactly `value`. */
  const holds = async (value: string): Promise<boolean> =>
    (await all()).some(node => node.text === value || node.value === value)
  try {
    await app.open(scorePath(world.ids.game))
    await m.assertVisible({ text: '^Open scoring menu$', timeout: 30000 })
    if ((await all()).some(node => label(node) === 'Close')) await tap('Close')
    await tap('Open scoring menu')
    await tap('Set Team Rosters')
    await shot('lineup')
    await tap('Defense')
    await m.assertVisible({ text: '^Drag player into defensive position$' })
    await shot('defense')
    await tap('Clear P')
    await m.assertVisible({ text: actionPattern('Assign P') })

    await drag('Player 1', 'Assign P')
    await m.assertVisible({ text: actionPattern('Clear P') })
    await tap('Clear P')
    await m.assertVisible({ text: actionPattern('Assign P') })
    log('PASS held upward defensive drag and whole-card clear')
    await drag('Player 1', 'Clear C')
    await noRosterCard('Player 1')
    await m.assertVisible({ text: '^Player 2$' })
    await drag('Player 2', 'Assign P')
    await tap('Home Team')
    await tap('Away Team')
    await tap('Lineup')
    await tap('Defense')
    await m.assertVisible({ text: actionPattern('Clear P') })
    log('PASS occupied-target replacement and draft across team/mode switches')
    await tap('Save Rosters')
    await tap('Open scoring menu')
    await tap('Set Team Rosters')
    await tap('Defense')
    await m.assertVisible({ text: actionPattern('Clear P') })
    await tap('Cancel')
    await tap('Undo Set team roster')
    log('PASS Save/reopen and Undo')
    await tap('Open scoring menu')
    await tap('Set Team Rosters')
    await tap('Defense')
    for (const position of ['P', 'C', '1B', '2B', 'SS'])
      await tap(`Clear ${position}`)
    if (platform === 'ios') {
      const roster = await bounds('Roster players')
      let visible = false
      for (let attempt = 0; attempt < 8; attempt++) {
        visible = (await all()).some(
          node =>
            label(node) === 'Player 14' &&
            node.bounds != null &&
            node.bounds.y >= roster.y &&
            node.bounds.y + node.bounds.height <= roster.y + roster.height
        )
        if (visible) break
        await m.swipe({
          start: pointOf({
            x: roster.x + roster.width / 2,
            y: roster.y + roster.height * 0.8
          }),
          end: pointOf({
            x: roster.x + roster.width / 2,
            y: roster.y + roster.height * 0.2
          }),
          duration: 250
        })
        await sleep(500)
      }
      expect(visible, 'Lower roster card scrolled into view').to.equal(true)
    } else
      await m.scrollUntilVisible({
        element: { text: '^Player 14$' },
        from: { text: '^Roster players$' },
        direction: 'DOWN',
        timeout: 15000
      })
    await drag('Player 14', 'Assign P')
    await m.assertVisible({ text: actionPattern('Clear P') })
    await noRosterCard('Player 14')
    log('PASS scroll lower roster and drag upward to field')
    await tap('Cancel')
    await tap('Open scoring menu')
    await tap('Set Team Rosters')
    await tap('Defense')
    await m.assertVisible({ text: actionPattern('Clear P') })
    log('PASS Cancel restores original defense')

    await tap('Create Player')
    await m.assertVisible({ text: '^First Name$' })
    await m.assertVisible({ text: '^Create Placeholder Player$' })
    if (platform === 'ios')
      expect(
        await keyboardShown(m),
        'Creating a player does not open the keyboard automatically'
      ).to.equal(false)
    await tap('First Name')
    await m.inputText({ text: 'Alex' })
    if (platform === 'android') {
      await tap('Next')
      await m.assertVisible({ text: '^Next$' })
    } else await m.pressKey({ key: 'Enter' })
    await sleep(700)
    await m.inputText({ text: 'Demo' })
    if (platform === 'android') {
      await tap('Next')
      await m.assertVisible({ text: '^Done$' })
    } else await m.pressKey({ key: 'Enter' })
    await sleep(700)
    await m.inputText({ text: '42' })
    if (platform === 'android') {
      await tap('Done')
      await m.assertNotVisible({ text: '^Done$' })
    } else await m.pressKey({ key: 'Enter' })
    await sleep(700)
    for (const value of ['Alex', 'Demo', '42'])
      expect(await holds(value), `Field contains ${value}`).to.equal(true)
    if (platform === 'ios')
      expect(
        await keyboardShown(m),
        'Keyboard dismissed after jersey submit'
      ).to.equal(false)
    await shot('player')
    await m.scrollUntilVisible({
      element: { text: '^Create Placeholder Player$' },
      direction: 'DOWN',
      timeout: 15000
    })
    await m.assertVisible({ text: '^Create Placeholder Player$' })
    log('PASS sequential keyboard entry and placeholder action available')
    await m.scrollUntilVisible({
      element: { text: '^Save and Create Another Player$' },
      direction: 'DOWN',
      timeout: 15000
    })
    await tap('Save and Create Another Player')
    await m.assertVisible({ text: '^First Name$' })
    if (platform === 'ios')
      expect(
        await holds('Alex'),
        'First name resets after adding another'
      ).to.equal(false)
    await shot('player-reset')
    log('PASS Save and Create Another resets and refocuses form')
    await m.inputText({ text: 'Mookie' })
    if (platform === 'ios')
      expect(
        await holds('Mookie'),
        'Save and Create Another focuses First Name'
      ).to.equal(true)
    await tap('Cancel')
    await tap('Create Player')
    await tap('Create Placeholder Player')
    await m.assertVisible({ text: '^Select number of players to create.$' })
    await tap('Create')
    await m.assertNotVisible({ text: '^First Name$' })
    await m.assertVisible({ text: '^Save Rosters$' })
    log('PASS placeholder addition closes player entry and returns to roster')
  } finally {
    writeFileSync(
      ctx.artifact(`${prefix}-field-acceptance.log`),
      lines.join('\n') + '\n'
    )
  }
}

const phone = (needs: string): SurfaceNeeds => ({
  // The scoring screen's field draws in 3D: a GPU, so a physical phone.
  devices: [
    { role: 'device', needs: [needs, 'gpu'], simulator: 'never' as const }
  ]
})

export default defineHarness({
  id: 'scoring/roster-field/defense-and-player-entry',
  title: 'Held drags fill the defense and the player form takes the keyboard',
  kind: 'e2e',
  covers: [
    'src/app/scoring/RosterEditor.tsx',
    'src/app/scoring/RosterSelector*.tsx',
    'src/app/scoring/PlaceholderPlayersSheet.tsx',
    'src/app/scoring/playerDraft.ts'
  ],
  stack: 'isolated',
  fixtures: ['roster-players'],
  exclusive: false,
  surfaces: {
    'ios-app': phone('ios-phone'),
    'android-app': phone('android-phone'),
    'web-safari-ios': phone('ios-phone')
  },
  services: [],
  apps: ['teamstation-ios', 'teamstation-android'],
  secrets: [],
  costUsd: 0,
  minutes: 15,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'defense-and-player-entry': acceptance
  }
})
