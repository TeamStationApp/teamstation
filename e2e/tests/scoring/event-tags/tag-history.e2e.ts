import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import {
  historyTargets,
  tagMetadata,
  tagTargets
} from '../../../../src/common/eventTags'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import {
  apiAs,
  centre,
  type Node,
  openPhoneScorer,
  scorePath,
  sleep,
  until
} from '../../../rigs/scoring/phoneScorer'

/**
 * Tagging scoring events from the scoring screen's history, in Safari and
 * in the app on an iPhone (`event-tags`: Visitor 01 struck out swinging,
 * then a Ball): a long press on Undo lists the last six events in order,
 * a tap outside dismisses it, a typed multiword tag is saved normalized, a
 * recent tag's pill tags another event, both survive a reload, the editor
 * offers recent and popular tags and leaves every description as it was,
 * an older play's editor keeps its full description, a short Undo takes
 * back exactly one pitch, recents carry across games, and the highlight
 * card and the selected description carry the tag.
 */

async function tagHistory(ctx: HarnessContext): Promise<void> {
  const world = await ctx.fixture('event-tags')
  const gameIds = [world.ids.tagged, world.ids.second]
  const { client } = await apiAs(ctx, world.accounts.scorer)
  const app = await openPhoneScorer(ctx, 'scorer')
  const { m, browser } = app
  const name = browser ? 'safari' : 'native'
  const report: string[] = []
  const apiReport: string[] = []
  const log = (message: string): void => {
    report.push(message)
  }
  const flat = async (): Promise<Node[]> => await app.nodes()
  const targets = async (id: string): Promise<any[]> => {
    const stored = await client.gameEvents(id)
    return [
      ...stored.plays,
      ...(stored.currentPlay == null ? [] : [stored.currentPlay])
    ].flatMap(tagTargets)
  }
  const touch = async (text: string): Promise<void> => {
    const matches = (await flat()).filter(
      node => node.text === text && node.bounds != null
    )
    const match = matches.find(node => node.type === 'Button') ?? matches[0]
    if (match?.bounds == null) {
      await m.tapOn({ text: `^${text}$`, timeout: 10000 })
      return
    }
    const at = centre(match.bounds)
    await m.tapOnPoint({ x: Math.round(at.x), y: Math.round(at.y) })
  }
  const hold = async (): Promise<void> => {
    const undo = (await flat()).find(node =>
      (node.text ?? '').startsWith('Undo ')
    )
    expect(undo?.bounds, 'Undo control must be visible').to.not.equal(undefined)
    const at = centre(undo!.bounds!)
    await m.tapOnPoint({
      x: Math.round(at.x),
      y: Math.round(at.y),
      duration: 2200
    })
    await m.assertVisible({
      text: 'Tap event to assign a tag.',
      timeout: 10000
    })
  }
  const shot = async (state: string): Promise<void> => {
    await m.takeScreenshot({ path: ctx.artifact(`${name}-${state}-after.png`) })
  }
  const open = async (game: string, score: boolean): Promise<void> => {
    await app.open(
      scorePath(game, score) + (browser ? `?acceptance=${Date.now()}` : '')
    )
    // The app may still be loading its session.
    await until(
      async () =>
        (await flat()).some(
          node =>
            node.text === 'E-mail address' ||
            node.text === 'Open scoring menu' ||
            node.text === 'Video' ||
            node.text === 'Videos' ||
            node.text === 'Box score' ||
            node.text === 'Box Score'
        ),
      'App route did not load'
    )
    if ((await flat()).some(node => node.text === 'E-mail address'))
      await ctx.signIn('scorer', m)
    if (score) {
      await m.assertVisible({ text: 'Open scoring menu', timeout: 30000 })
      await m.assertVisible({ text: '^Host 08$', timeout: 30000 })
      let last = ''
      let stable = 0
      await until(async () => {
        const undo = (await flat()).find(
          node =>
            (node.text ?? '').startsWith('Undo ') ||
            node.text === 'Nothing to undo'
        )
        const bounds = JSON.stringify(undo?.bounds)
        stable = bounds === last && undo?.bounds != null ? stable + 1 : 0
        last = bounds
        return stable >= 3
      }, 'Undo geometry did not settle')
    }
    const warning = (await flat()).find(
      node => node.text?.includes('Open debugger to view warnings.') === true
    )
    if (warning?.bounds != null)
      await m.tapOnPoint({
        x: Math.round(warning.bounds.x + warning.bounds.width - 24),
        y: Math.round(warning.bounds.y + warning.bounds.height / 2)
      })
  }
  try {
    await open(gameIds[0], true)
    const secondStored = await client.gameEvents(gameIds[1])
    await client.saveGameEvents(gameIds[1], {
      plays: [],
      remove: secondStored.plays.map((play: any) => play.about.atBatIndex),
      currentPlay: null
    })
    if ((await targets(gameIds[0])).length === 5) {
      await touch('Swing and Miss')
      await until(
        async () => (await targets(gameIds[0])).length >= 6,
        'The sixth pitch did not save'
      )
    }
    await until(async () => {
      const stored = await client.gameEvents(gameIds[0])
      const completed = stored.plays.find(
        (play: any) => play.about.atBatIndex === 0
      )
      return (
        completed != null &&
        tagMetadata(completed).play != null &&
        stored.currentPlay?.about.atBatIndex !== 0
      )
    }, 'The pitch presentation did not finish')
    const first = await targets(gameIds[0])
    expect(
      first.length >= 6,
      'The game holds six or more scoring events'
    ).to.equal(true)
    const firstStored = await client.gameEvents(gameIds[0])
    const logical = [
      ...firstStored.plays,
      ...(firstStored.currentPlay == null ? [] : [firstStored.currentPlay])
    ].flatMap(historyTargets)
    const description = await client.gameEvents(gameIds[0])
    await hold()
    const rows = (await flat())
      .filter(
        node =>
          (node.text ?? '').startsWith('Tag event: ') && node.bounds != null
      )
      .sort((a, b) => a.bounds!.y - b.bounds!.y)
    expect(rows.length).to.equal(6)
    expect(rows.map(node => node.text)).to.deep.equal(
      logical.slice(-6).map(target => `Tag event: ${target.title}`)
    )
    await shot('history')
    await m.tapOnPoint({ x: 20, y: 200 })
    await m.assertNotVisible({
      text: 'Tap event to assign a tag.',
      timeout: 10000
    })
    await hold()
    const completed = logical.at(-1)!
    await touch(`Tag event: ${completed.title}`)
    await m.assertVisible({ text: 'New tag', timeout: 10000 })
    await touch('New tag')
    await m.eraseText({ characters: 128 })
    await m.inputText({ text: '  GREAT  Catch ' })
    await m.hideKeyboard()
    if ((await flat()).some(node => node.text === 'Save tag'))
      await touch('Save tag')
    await until(
      async () =>
        (await targets(gameIds[0])).find(target => target.id === completed.id)
          ?.tag === 'great catch',
      'Typed tag did not persist'
    )
    log(
      `${name}: six chronological rows, outside dismissal and typed multiword tag PASS`
    )
    await hold()
    const pitch = logical.slice(-6)[0]
    await touch(`Tag event: ${pitch.title}`)
    await m.assertVisible({ text: 'Use tag great catch', timeout: 10000 })
    await touch('Use tag great catch')
    await until(
      async () =>
        (await targets(gameIds[0])).find(target => target.id === pitch.id)
          ?.tag === 'great catch',
      'Pill selection did not persist'
    )
    await open(gameIds[0], true)
    const reloaded = await targets(gameIds[0])
    expect(reloaded.find(target => target.id === completed.id)?.tag).to.equal(
      'great catch'
    )
    expect(reloaded.find(target => target.id === pitch.id)?.tag).to.equal(
      'great catch'
    )
    // Enough real assignments to show wrapping at the normal text size.
    const labels = [
      'late rally',
      'quick release',
      'sharp defense',
      'strong finish'
    ]
    const others = first.filter(
      target => target.id !== completed.id && target.id !== pitch.id
    )
    for (let at = 0; at < labels.length; at++)
      await client.saveEventTag(gameIds[0], others[at].id, labels[at])
    await hold()
    await touch(`Tag event: ${completed.title}`)
    await m.assertVisible({ text: 'Recent tags', timeout: 10000 })
    await m.assertVisible({ text: 'Popular tags', timeout: 10000 })
    await shot('editor')
    await touch('Cancel')
    const unchanged = await client.gameEvents(gameIds[0])
    expect(
      unchanged.plays.map((play: any) => play.result.description)
    ).to.deep.equal(
      description.plays.map((play: any) => play.result.description)
    )
    const choice = await client.tagChoices()
    expect(choice.popular[0].tag).to.equal('great catch')
    expect(choice.popular[0].count).to.equal(2)
    await touch('Ball')
    await until(
      async () => (await targets(gameIds[0])).length === first.length + 1,
      'New pitch did not save'
    )
    await hold()
    await touch(`Tag event: ${completed.title}`)
    await m.assertVisible({
      text: 'Visitor 0.*strikes out swinging',
      timeout: 10000
    })
    await touch('Cancel')
    await touch('Undo Ball')
    await until(
      async () => (await targets(gameIds[0])).length === first.length,
      'Undo did not take the new pitch back'
    )
    log(
      `${name}: older completed-play editor retains its full event description PASS`
    )
    await open(gameIds[1], true)
    await touch('Ball')
    await until(
      async () => (await targets(gameIds[1])).length > 0,
      'Second game pitch did not save'
    )
    await touch('Undo Ball')
    await until(
      async () => (await targets(gameIds[1])).length === 0,
      'Short Undo did not undo exactly one pitch'
    )
    await touch('Ball')
    await until(
      async () => (await targets(gameIds[1])).length > 0,
      'Replacement pitch did not save'
    )
    await hold()
    await touch('Tag event: Ball')
    await m.assertVisible({ text: 'Use tag great catch', timeout: 10000 })
    await touch('Use tag great catch')
    await until(
      async () => (await targets(gameIds[1]))[0]?.tag === 'great catch',
      'Account recents did not work across games'
    )
    log(
      `${name}: pill selection, save/reload, short Undo and recents across games PASS`
    )
    await open(gameIds[0], false)
    await touch(browser ? 'Videos' : 'Video')
    await m.assertVisible({ text: 'Strikeout: Host 01.*', timeout: 20000 })
    await m.swipe({ start: '360,700', end: '360,400', duration: 100 })
    await sleep(500)
    const card = (await flat()).find(
      node =>
        node.text?.includes('Strikeout: Host 01 great catch') === true &&
        node.bounds != null
    )
    expect(
      card?.bounds,
      'Tagged highlight card must have visible bounds'
    ).to.not.equal(undefined)
    const at = centre(card!.bounds!)
    await m.tapOnPoint({ x: Math.round(at.x), y: Math.round(at.y) })
    await m.assertVisible({ text: 'Top 1st:.*great catch', timeout: 10000 })
    await shot('highlight')
    log(
      `${name}: selected description and highlight card append one intact multiword pill PASS`
    )
    apiReport.push(
      `${name}: play and pitch tags persist independently; original descriptions unchanged; popular count equals active assignments; short Undo removes target and replacement has a fresh identity.`
    )
    apiReport.push('$ GET /api/v1/tags')
    apiReport.push(JSON.stringify(await client.tagChoices(), null, 2))
  } finally {
    writeFileSync(ctx.artifact('tags-ui.log'), report.join('\n') + '\n')
    writeFileSync(ctx.artifact('tags-api.log'), apiReport.join('\n') + '\n')
  }
}

const iphone = {
  // The scoring field draws in 3D: a GPU, so a physical iPhone.
  devices: [
    { role: 'device', needs: ['ios-phone', 'gpu'], simulator: 'never' as const }
  ]
}

export default defineHarness({
  id: 'scoring/event-tags/tag-history',
  title: "Scoring events are tagged from the scoring screen's history",
  kind: 'e2e',
  covers: [
    'src/app/scoring/EventTagEditor.tsx',
    'src/app/scoring/localEventTags.ts',
    'src/common/eventTags.ts',
    'src/server/events/eventTags.ts'
  ],
  stack: 'isolated',
  fixtures: ['event-tags'],
  exclusive: false,
  surfaces: {
    'web-safari-ios': iphone,
    'ios-app': iphone
  },
  services: [],
  apps: ['teamstation-ios'],
  secrets: [],
  costUsd: 0,
  minutes: 15,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'tag-history': tagHistory
  }
})
