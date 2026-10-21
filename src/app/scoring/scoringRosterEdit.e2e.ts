import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

import { recordOf } from '../../common/scoring/gumbo'
import { rosterEditFixture } from './scoringRosterEdit.e2e.fixture'

const required = (name: string): string => {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}
const clientRequire = createRequire(
  join(required('MAESTRO_D_CLIENT_ROOT'), 'package.json')
)
const { MaestroD } = clientRequire('maestro-d')
interface Node {
  text?: string
  id?: string
  type?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: Node[]
}
const flat = (node: Node): Node[] => [
  node,
  ...(node.children ?? []).flatMap(flat)
]
const pause = async (): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, 500))
}

async function main(): Promise<void> {
  const surface = required('SCORING_MODAL_SURFACE')
  assert(['safari', 'native'].includes(surface))
  const native = surface === 'native'
  const phase = process.env.SCORING_ROSTER_PHASE ?? 'after'
  const section = process.env.SCORING_ROSTER_SECTION ?? 'all'
  assert(['before', 'after'].includes(phase))
  const artifacts = resolve(required('SCORING_ARTIFACT_DIR'))
  const device = required('SCORING_DEVICE_UDID')
  await mkdir(artifacts, { recursive: true })
  const fixture = await rosterEditFixture(
    required('SCORING_ASSET_URL'),
    Number(required('SCORING_FIXTURE_PORT'))
  )
  const hasPitch = (): boolean =>
    [
      ...fixture.stored().plays,
      ...(fixture.stored().currentPlay == null
        ? []
        : [fixture.stored().currentPlay!])
    ].some(
      play =>
        recordOf(play)?.actions.some(action => action.type === 'pitch') === true
    )
  const daemon = await MaestroD.connect({
    name: required('MAESTRO_D'),
    spawn: false
  }).catch(async (error: unknown) => {
    await fixture.close()
    throw error
  })
  const m = await daemon
    .attach({
      device,
      platform: 'ios',
      appId: native ? 'app.teamstation.app' : 'com.apple.mobilesafari',
      artifacts: 'on-failure',
      waitForIdleTimeout: 500,
      stepDelay: 250
    })
    .catch(async (error: unknown) => {
      daemon.close()
      await fixture.close()
      throw error
    })
  const driver = async (): Promise<string> => {
    const log = await readFile(join(daemon.info.runDir, 'daemon.log'), 'utf8')
    const line = log
      .split('\n')
      .filter(value =>
        value.includes(`Starting WDA on device ${device} (port:`)
      )
      .at(-1)
    const port = /\(port: (\d+)\)/.exec(line ?? '')?.[1]
    assert(port != null)
    const endpoint = `http://127.0.0.1:${port}`
    const status = await m.eval(
      `http.get(${JSON.stringify(endpoint + '/status')})`
    )
    const session = JSON.parse(status.body).sessionId
    assert(typeof session === 'string')
    return endpoint + '/session/' + session
  }
  const point = async (x: number, y: number): Promise<void> => {
    await m.tapOnPoint({ x: Math.round(x), y: Math.round(y), duration: 100 })
    await pause()
  }
  const shown = async (label: string): Promise<void> => {
    const until = Date.now() + 30000
    while (Date.now() < until) {
      if (
        flat(await m.hierarchy()).some(
          node => node.text?.includes(label) === true || node.id === label
        )
      )
        return
      await pause()
    }
    assert.fail(`Missing visible control: ${label}`)
  }
  const waitForState = async (
    check: () => Promise<boolean>,
    message: string
  ): Promise<void> => {
    const until = Date.now() + 30000
    while (Date.now() < until) {
      if (await check()) return
      await pause()
    }
    assert(await check(), message)
  }
  const tap = async (label: string): Promise<void> => {
    await shown(label)
    const isPlayerRow = flat(await m.hierarchy()).some(
      node =>
        node.text?.startsWith(label + ',') === true &&
        node.text.endsWith(', edit settings')
    )
    if (isPlayerRow) {
      const ready = Date.now() + 30000
      const loading = async (): Promise<boolean> =>
        flat(await m.hierarchy()).some(
          node =>
            node.text === 'Loading team roster' ||
            node.id === 'Loading team roster'
        )
      while ((await loading()) && Date.now() < ready) await pause()
      assert(!(await loading()), 'Roster refresh must finish before player tap')
      await m.waitForAnimationToEnd({ timeout: 3000 })
      await reach(label)
    }
    if (native) {
      const warning = flat(await m.hierarchy()).find(
        node => node.text?.includes('Open debugger to view warnings.') === true
      )
      if (warning?.bounds != null)
        await point(
          warning.bounds.x + warning.bounds.width - 22,
          warning.bounds.y + warning.bounds.height / 2
        )
    }
    await m.waitForAnimationToEnd({ timeout: 3000 })
    if (native) await new Promise(resolve => setTimeout(resolve, 800))
    const hierarchy = await m.hierarchy()
    const all = flat(hierarchy)
    const nodes = native
      ? all
      : flat(all.find(node => node.type === 'WebView') ?? hierarchy)
    const node = nodes
      .filter(
        node =>
          (node.text === label ||
            node.id === label ||
            node.text?.startsWith(label + ',') === true) &&
          node.bounds != null
      )
      .at(-1)
    assert(node?.bounds != null)
    console.log('Tap', label, node.bounds)
    await point(
      node.bounds.x + node.bounds.width / 2,
      node.bounds.y + node.bounds.height / 2
    )
  }
  const tapStarts = async (prefix: string): Promise<void> => {
    await m.waitForAnimationToEnd({ timeout: 3000 })
    const hierarchy = await m.hierarchy()
    const all = flat(hierarchy)
    const nodes = native
      ? all
      : flat(all.find(node => node.type === 'WebView') ?? hierarchy)
    const target = nodes
      .filter(
        node => node.text?.startsWith(prefix) === true && node.bounds != null
      )
      .at(-1)?.bounds
    assert(target != null, `Target starting ${prefix} must exist`)
    await point(target.x + target.width / 2, target.y + target.height / 2)
  }
  const browserStep = async (direction: 'Back' | 'Forward'): Promise<void> => {
    const target = flat(await m.hierarchy()).find(
      node => node.id === direction + 'Button'
    )?.bounds
    assert(target != null, `Safari ${direction} must be available`)
    await point(target.x + target.width / 2, target.y + target.height / 2)
  }
  const open = async (path: string): Promise<void> => {
    const link = native
      ? `teamstation://${path}`
      : `${required('SCORING_TEST_URL')}/${path}`
    const result = await m.eval(
      `http.post(${JSON.stringify((await driver()) + '/url')},{body:${JSON.stringify({ url: link, bundleId: native ? 'app.teamstation.app' : 'com.apple.mobilesafari', idleTimeoutMs: 1500 })}})`
    )
    assert.equal(result.status, 200)
    assert(JSON.parse(result.body).value?.error == null)
    await pause()
  }
  const capture = async (name: string): Promise<void> => {
    await m.waitForAnimationToEnd({ timeout: 3000 })
    if (native) {
      const warning = flat(await m.hierarchy()).find(
        node => node.text?.includes('Open debugger to view warnings.') === true
      )
      if (warning?.bounds != null)
        await point(
          warning.bounds.x + warning.bounds.width - 22,
          warning.bounds.y + warning.bounds.height / 2
        )
    }
    await writeFile(
      join(artifacts, `${surface}-${name}.png`),
      await m.screenshot()
    )
    console.log('Captured', name)
  }
  const input = async (label: string, value: string): Promise<void> => {
    await tap(label)
    await m.eraseText()
    if (value !== '') await m.inputText({ text: value })
    if (native) await m.hideKeyboard()
    else await m.tapOn({ text: '^Done$', timeout: 10000 })
  }
  const reach = async (label: string): Promise<void> => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const nodes = flat(await m.hierarchy())
      const screen = nodes.find(node => node.type === 'Window')?.bounds
      const target = nodes
        .filter(
          node =>
            node.text === label ||
            node.id === label ||
            node.text?.startsWith(label + ',') === true
        )
        .at(-1)?.bounds
      assert(screen != null)
      if (
        target != null &&
        target.y > 110 &&
        target.y + target.height <
          screen.height -
            ([
              'Create Placeholder Player',
              'Create Player',
              'Save Player'
            ].includes(label)
              ? native
                ? 35
                : 100
              : 120)
      )
        return
      await m.swipe({ start: '65%,75%', end: '65%,35%', duration: 400 })
    }
    assert.fail(`Action must be reachable: ${label}`)
  }
  const regressions = async (): Promise<void> => {
    // Earlier Settings visits can move this player below the first viewport.
    // Give standalone E6 the same ordering so it tests scrolling too.
    const seeded = await fetch(
      `${fixture.backendUrl}/api/v1/teams/away/players/100/settings`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jersey: '14' })
      }
    )
    assert(seeded.ok, 'The regression roster must contain the edited jersey')
    await open(`games/${fixture.gameId}/score`)
    await shown('Open scoring menu')
    await tap('Open scoring menu')
    await tap('Set Team Rosters')
    const nodes = flat(await m.hierarchy())
    const from = nodes.find(node => node.text === 'Drag Mike T')?.bounds
    const to = nodes.find(node => node.text === 'Reorder Mookie B')?.bounds
    assert(from != null && to != null)
    await m.dragAndDrop({
      from: {
        point: `${Math.round(from.x + from.width / 2)},${Math.round(from.y + from.height / 2)}`
      },
      to: {
        point: `${Math.round(to.x + to.width / 2)},${Math.round(to.y + 6)}`
      },
      holdDuration: 700,
      duration: 1000
    })
    const order = [
      ...new Set(
        flat(await m.hierarchy())
          .filter(node => node.text?.startsWith('Reorder ') === true)
          .map(node => node.text)
      )
    ]
    assert.deepEqual(order.slice(0, 2), ['Reorder Mike T', 'Reorder Mookie B'])
    await tap('Defense')
    await shown('CF')
    await tap('Lineup')
    await tap('Create Player')
    if (native) await m.hideKeyboard()
    else await m.tapOn({ text: '^Done$', timeout: 10000 })
    if (native)
      for (
        let count = 0;
        count < 3 &&
        flat(await m.hierarchy()).some(node => node.type === 'Keyboard');
        count++
      )
        await m.pressKey('Enter')
    await reach('Create Placeholder Player')
    await tap('Create Placeholder Player')
    await shown('Select number of players to create')
    await tap('Cancel')
    await input('First Name', 'Jose')
    await input('Last Name', 'Ramirez')
    await input('Jersey Number', '11')
    await reach('Create Player')
    await tap('Create Player')
    await shown('Jose Ramirez')
    await tap('Create Player')
    if (native) await m.hideKeyboard()
    else await m.tapOn({ text: '^Done$', timeout: 10000 })
    if (native)
      for (
        let count = 0;
        count < 3 &&
        flat(await m.hierarchy()).some(node => node.type === 'Keyboard');
        count++
      )
        await m.pressKey('Enter')
    await reach('Create Placeholder Player')
    await tap('Create Placeholder Player')
    await tap('Create')
    await tap('Cancel')
    await tap('Roster')
    await shown('game-only player')
    await tap('Defense')
    await tap('Clear P')
    await shown('Assign P')
    const defenders = flat(await m.hierarchy())
    const pitcher = defenders.find(node => node.text === 'Mookie B')?.bounds
    const place = defenders.find(node => node.text === 'Assign P')?.bounds
    assert(pitcher != null && place != null)
    await m.dragAndDrop({
      from: {
        point: `${Math.round(pitcher.x + pitcher.width / 2)},${Math.round(pitcher.y + pitcher.height / 2)}`
      },
      to: {
        point: `${Math.round(place.x + place.width / 2)},${Math.round(place.y + place.height / 2)}`
      },
      holdDuration: 700,
      duration: 1000
    })
    await shown('Clear P')
    await tap('Cancel')
    fixture.pauseWrites(true)
    await tap('Ball')
    await shown('Undo Ball')
    await tap('Open scoring menu')
    await tap('Set Team Rosters')
    await tap('Roster')
    await reach('Mookie Betts')
    await tap('Mookie Betts')
    await shown('JERSEY NUMBER')
    await tap('Home')
    await shown('Discard and Exit')
    await capture('pending-exit')
    await tap('Cancel')
    await shown('JERSEY NUMBER')
    await tap('Back')
    await shown('Tap player to edit.')
    fixture.pauseWrites(false)
    const until = Date.now() + 15000
    while (fixture.stored().currentPlay == null && Date.now() < until)
      await pause()
    assert(fixture.stored().currentPlay != null)
    await tap('Cancel')
    await shown('Undo Ball')
    await m.waitForAnimationToEnd({ timeout: 3000 })
    const undo = flat(await m.hierarchy()).find(
      node => node.text === 'Undo Ball'
    )?.bounds
    assert(undo != null)
    await m.tapOnPoint({
      x: Math.round(undo.x + undo.width / 2),
      y: Math.round(undo.y + undo.height / 2),
      longPress: true,
      duration: 650
    })
    await shown('Tap event to assign a tag.')
    await capture('history-continuity')
    await tap('Dismiss scoring history')
    await tapStarts('Undo ')
    await shown('Nothing to undo')
    console.log(
      'PASS E6 placeholder/player creation and cancellation, lineup drag, defense, history and dirty exit'
    )
  }
  try {
    if (native) await m.stopApp()
    await m.launchApp()
    if (native) {
      const ready = Date.now() + 60000
      while (
        Date.now() < ready &&
        !flat(await m.hierarchy()).some(
          node =>
            node.text?.startsWith('Account,') === true ||
            node.text === 'Open scoring menu'
        )
      )
        await pause()
    }
    if (section === 'e6') {
      await regressions()
      console.log('PASS', surface, 'E6')
      return
    }
    await open(`games/${fixture.gameId}/score`)
    await shown('Open scoring menu')
    await new Promise(resolve => setTimeout(resolve, 1500))
    if (
      phase === 'after' &&
      ['all', 'namesPersisted', 'names'].includes(section)
    ) {
      const until = Date.now() + 45000
      const accepted = async (): Promise<boolean> =>
        flat(await m.hierarchy()).some(
          node => node.text?.startsWith('Undo Ball') === true
        )
      while (!hasPitch() && Date.now() < until)
        if (await accepted()) await pause()
        else {
          await tap('Ball')
          // Acknowledged input may still be waiting for the debounced write.
          // Retry only an ignored warm-start tap, never an accepted pitch.
          const persisted = Date.now() + 5000
          while (!hasPitch() && !(await accepted()) && Date.now() < persisted)
            await pause()
        }
      assert(hasPitch(), 'A scored pitch is required for continuity testing')
      const pitches = [
        ...fixture.stored().plays,
        ...(fixture.stored().currentPlay == null
          ? []
          : [fixture.stored().currentPlay!])
      ].flatMap(play =>
        (recordOf(play)?.actions ?? []).filter(
          action => action.type === 'pitch'
        )
      )
      assert.equal(
        pitches.length,
        1,
        'Continuity starts with exactly one pitch'
      )
    }
    for (let attempt = 0; attempt < 6; attempt++) {
      if (
        flat(await m.hierarchy()).some(node => node.text === 'Set Team Rosters')
      )
        break
      await tap('Open scoring menu')
    }
    await tap('Set Team Rosters')
    await shown('Lineup')
    if (section === 'namesPersisted' || section === 'names') {
      await tap('Roster')
      await tap('Mookie Betts')
      await shown('FIRST NAME')
      await input('First name', '')
      await input('Last name', '')
      await input('Jersey number', '14')
      await reach('Save')
      await tap('Save')
      await shown('Enter a player name.')
      for (let count = 0; count < 2; count++)
        await m.swipe({ start: '65%,35%', end: '65%,75%', duration: 400 })
      await input('First name', 'Paul')
      await input('Last name', 'Goldschmidt')
      fixture.saveFailure(true)
      await reach('Save')
      await tap('Save')
      await shown('Fixture request temporarily unavailable')
      await capture('names-error')
      fixture.saveFailure(false)
      await tap('Save')
      await shown('Saved.')
      assert(
        fixture.trace.some(
          line =>
            line.includes('"firstName":"Paul"') &&
            line.includes('"lastName":"Goldschmidt"') &&
            line.includes('"jersey":"14"') &&
            line.includes('-> 200')
        )
      )
      for (let count = 0; count < 2; count++)
        await m.swipe({ start: '65%,35%', end: '65%,75%', duration: 400 })
      await shown('Paul Goldschmidt')
      await capture('names-settings')
      await tap('Back')
      await shown('Paul Goldschmidt')
      await reach('Paul Goldschmidt')
      await capture('names-roster')
      assert(
        hasPitch(),
        'Editing a persisted name must preserve the scored pitch'
      )
      if (section === 'namesPersisted') {
        console.log(
          'PASS names persisted: atomic Save, validation, refused Save, header, Back, retained pitch'
        )
        return
      }
      await tap('Create Player')
      await input('First Name', 'Jose')
      await input('Last Name', 'Ramirez')
      await input('Jersey Number', '11')
      await reach('Create Player')
      await tap('Create Player')
      await shown('Jose Ramirez')
      await reach('Jose Ramirez')
      await capture('local-card')
      await tap('Save Rosters')
      const latestSetup = (): NonNullable<
        ReturnType<typeof recordOf>
      >['setupBefore'] => {
        const actions = [
          ...fixture.stored().plays,
          ...(fixture.stored().currentPlay == null
            ? []
            : [fixture.stored().currentPlay!])
        ].flatMap(play => recordOf(play)?.actions ?? [])
        const action = actions
          .filter(
            action => action.type === 'lineup' && action.kind === 'roster'
          )
          .at(-1)
        assert(action?.type === 'lineup' && action.setup != null)
        return action.setup
      }
      await waitForState(async () => {
        try {
          return Object.values(latestSetup().players).some(
            player => player.fullName === 'Jose Ramirez'
          )
        } catch {
          return false
        }
      }, 'Creation must persist the game-only identity')
      const before = latestSetup()
      const original = Object.values(before.players).find(
        player => player.fullName === 'Jose Ramirez'
      )!
      assert(original.local)
      assert.equal(before.players[original.id], original)
      assert(
        before.sides.away.players.includes(original.id) ||
          before.sides.home.players.includes(original.id),
        'The saved guest must belong to a game roster under its scoring identity'
      )
      const reopen = async (): Promise<void> => {
        await shown('Open scoring menu')
        await tap('Open scoring menu')
        await tap('Set Team Rosters')
        await tap('Roster')
      }
      await reopen()
      await tap('Jose Ramirez')
      await shown('Edit Player')
      await input('Last Name', 'Altuve')
      await tap('Cancel')
      await shown('Jose Ramirez')
      assert(
        !flat(await m.hierarchy()).some(
          node => node.text?.startsWith('Jose Altuve,') === true
        )
      )
      await tap('Jose Ramirez')
      await input('Last Name', 'Altuve')
      await input('Jersey Number', '00')
      await tap('Throws L')
      await tap('Bats S')
      await tap('Player position DH')
      await capture('names-local')
      await reach('Save Player')
      await tap('Save Player')
      await shown('Jose Altuve')
      await tap('Save Rosters')
      await waitForState(
        async () =>
          latestSetup().players[original.id]?.fullName === 'Jose Altuve',
        'The same game-only player must persist its corrected name'
      )
      const after = latestSetup()
      assert.deepEqual(after.sides, before.sides)
      assert.deepEqual(after.tagOrder, before.tagOrder)
      assert.equal(after.players[original.id].id, original.id)
      assert.equal(after.players[original.id].jersey, '00')
      assert.equal(after.players[original.id].throws, 'left')
      assert.equal(after.players[original.id].bats, 'switch')
      assert(after.players[original.id].positions.includes('DH'))
      assert(hasPitch(), 'Local-player editing must retain the scored pitch')
      await reopen()
      await shown('Jose Altuve')
      await tap('Jose Altuve')
      await shown('Edit Player')
      console.log(
        'PASS names: local edit/cancel/save/reopen, stable ID/assignments, hands/positions and retained pitch'
      )
      await writeFile(
        join(artifacts, `${surface}-names-report.json`),
        JSON.stringify(
          {
            id: original.id,
            player: after.players[original.id],
            retainedPitch: hasPitch(),
            assignmentsUnchanged: true
          },
          null,
          2
        )
      )
      return
    }
    await capture(`lineup-${phase}`)
    if (phase === 'after' && section === 'all') await tap('Remove Aaron J')
    await tap('Defense')
    await capture(`defense-${phase}`)
    if (phase === 'after') {
      await tap('Roster')
      await capture('edit-roster')
      await shown('Mookie Betts')
      await shown('bats right, throws right')
      await tap('Home Team')
      await shown('Mookie Betts')
      await tap('Away Team')
      if (section !== 'm1') {
        const before = JSON.stringify(fixture.stored())
        await tap('Mookie Betts')
        await shown('JERSEY NUMBER')
        await shown('Mookie Betts')
        await capture('player-settings-after')
        await input('Jersey number', '12')
        await tap('P')
        await tap('SS')
        // Settings beside a team edits the jersey and positions; how a player
        // bats and throws is edited away from a team.
        await reach('Save')
        await tap('Save')
        const until = Date.now() + 15000
        while (
          !fixture.trace.some(
            line =>
              line.startsWith('PUT /api/v1/teams/away/players/100/settings') &&
              line.includes('-> 200')
          ) &&
          Date.now() < until
        )
          await pause()
        assert(
          fixture.trace.some(
            line =>
              line.includes('PUT /api/v1/teams/away/players/100/settings') &&
              line.includes('-> 200')
          )
        )
        await tap('Back')
        await shown('Tap player to edit.')
        await shown('Mookie Betts, jersey 12, bats right, throws right')
        assert.equal(
          JSON.stringify(fixture.stored()),
          before,
          'Settings typing and saves must not change scoring events'
        )
        await reach('Mookie Betts')
        await capture('roster-return')
        if (native && section === 'all') {
          await tap('Mookie Betts')
          await shown('JERSEY NUMBER')
          await tap('Stats')
          await tap('Back')
          await shown('Tap player to edit.')
        }
        if (section === 'all') {
          // Forward can reopen the child; its own tabs remain part of the visit.
          if (!native) {
            await browserStep('Forward')
            await shown('JERSEY NUMBER')
            await browserStep('Back')
            await shown('Tap player to edit.')
            await browserStep('Forward')
            await shown('JERSEY NUMBER')
            await tap('Stats')
            await tap('Back')
            await shown('Tap player to edit.')
          }
          await tap('Home Team')
          await shown('Mookie Betts, jersey 1, bats right, throws right')
          await tapStarts('Mookie Betts, jersey 1, bats right, throws right,')
          await shown('JERSEY NUMBER')
          await input('Jersey number', '0')
          await reach('Save')
          await tap('Save')
          const until = Date.now() + 15000
          while (
            !fixture.trace.some(
              line =>
                line.startsWith(
                  'PUT /api/v1/teams/home/players/200/settings'
                ) && line.includes('-> 200')
            ) &&
            Date.now() < until
          )
            await pause()
          assert(
            fixture.trace.some(
              line =>
                line.startsWith(
                  'PUT /api/v1/teams/home/players/200/settings'
                ) && line.includes('-> 200')
            )
          )
          await tap('Back')
          await shown('Mookie Betts, jersey 0')
          await tap('Away Team')
          await reach('Mookie Betts')
        }
        await tap('Mookie Betts')
        await shown('JERSEY NUMBER')
        await input('Jersey number', '14')
        fixture.pauseSettings(true)
        await reach('Save')
        await tap('Save')
        const pending = Date.now() + 15000
        while (
          !fixture.trace.some(line =>
            line.startsWith('Pending settings PUT')
          ) &&
          Date.now() < pending
        )
          await pause()
        assert(
          fixture.trace.some(line => line.startsWith('Pending settings PUT'))
        )
        await tap('Back')
        await shown('Tap player to edit.')
        fixture.pauseSettings(false)
        await shown('Mookie Betts, jersey 14')
        await reach('Mookie Betts')
        // Failed edits stay on the light form; Back keeps the dark draft.
        await tap('Mookie Betts')
        await shown('JERSEY NUMBER')
        await input('Jersey number', '13')
        fixture.saveFailure(true)
        await reach('Save')
        await tap('Save')
        await shown('Fixture request temporarily unavailable')
        await capture('settings-save-error')
        fixture.saveFailure(false)
        fixture.rosterFailure(true)
        await tap('Back')
        await shown('Unable to refresh the roster.')
        await capture('roster-refresh-error')
        fixture.rosterFailure(false)
        await tap('Retry loading roster')
        await shown('Mookie Betts, jersey 14')
        if (section === 'all') {
          await waitForState(
            async () =>
              !flat(await m.hierarchy()).some(
                node =>
                  node.text === 'Loading team roster' ||
                  node.id === 'Loading team roster'
              ),
            'Roster refresh must finish before saving the draft'
          )
          await tap('Lineup')
          assert(
            !flat(await m.hierarchy()).some(
              node => node.text === 'Remove Aaron J'
            ),
            'Staged lineup must survive every player visit'
          )
          await tap('Save Rosters')
          await waitForState(async () => {
            const nodes = flat(await m.hierarchy())
            return (
              !nodes.some(
                node =>
                  node.text === 'Save Rosters' || node.id === 'Save Rosters'
              ) && nodes.some(node => node.text?.startsWith('Undo ') === true)
            )
          }, 'The roster sheet must close before Undo')
          await tapStarts('Undo ')
          await tapStarts('Undo ')
          await shown('Nothing to undo')
          const cleared = Date.now() + 15000
          while (hasPitch() && Date.now() < cleared) await pause()
          assert(
            !hasPitch(),
            'Undo must clear the pitch after undoing the roster change'
          )
          await tap('Open scoring menu')
          await tap('Set Team Rosters')
          await tap('Roster')
        }
        await reach('Mookie Betts')
        await fixture.roles([])
        await tap('Mookie Betts')
        await shown('Videos')
        await waitForState(
          async () =>
            !flat(await m.hierarchy()).some(
              node =>
                node.text === 'Settings' ||
                node.id === 'Settings' ||
                node.text?.includes('JERSEY NUMBER') === true ||
                node.id === 'JERSEY NUMBER' ||
                node.text?.includes('Mookie Betts') === true
            ),
          'Revoked Settings and private full name must be absent'
        )
        await tap('Back')
        await shown('Player settings are unavailable for this team.')
        assert(
          !flat(await m.hierarchy()).some(
            node => node.text?.includes('Mookie Betts') === true
          ),
          'Revoked full names must be removed'
        )
        await capture('permission-revoked')
        await fixture.roles(['scorekeeper'])
        await tap('Cancel')
        await tap('Open scoring menu')
        await tap('Set Team Rosters')
        await tap('Roster')
        await shown('Mookie Betts, jersey 14')
        await reach('Mookie Betts')
        await tap('Mookie Betts')
        await shown('JERSEY NUMBER')
        fixture.emptyRoster(true)
        await tap('Back')
        await shown('No players on this team.')
        await capture('roster-empty')
        fixture.emptyRoster(false)
      }
    }
    if (phase === 'after' && section === 'all') {
      await tap('Cancel')
      await open('teams/away?tab=roster')
      await shown('Mookie B')
      await reach('Mookie B')
      await tapStarts('Mookie B')
      await shown('Settings')
      await tap('Settings')
      await shown('JERSEY NUMBER')
      await shown('Mookie Betts')
      await tap('Back')
    } else await tap('Cancel')
    await open('players/100?tab=settings&onTeam=away')
    await shown(phase === 'before' ? 'Videos' : 'JERSEY NUMBER')
    if (phase === 'after') await shown('Mookie Betts')
    if (phase === 'before' || section === 'm1')
      await capture(`player-settings-${phase}`)
    if (
      phase === 'after' &&
      section === 'all' &&
      process.env.SCORING_ROSTER_REGRESSIONS === '1'
    )
      await regressions()
    console.log('PASS', surface, phase)
  } finally {
    try {
      await writeFile(
        join(artifacts, `${surface}-debug.png`),
        await m.screenshot()
      )
      await writeFile(
        join(artifacts, `${surface}-debug.json`),
        JSON.stringify(await m.hierarchy())
      )
      await writeFile(
        join(artifacts, `${surface}-baseline.log`),
        '$ Maestro D roster baseline\n' + fixture.trace.join('\n') + '\n'
      )
    } finally {
      try {
        await m.detach()
      } finally {
        daemon.close()
        await fixture.close()
      }
    }
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
