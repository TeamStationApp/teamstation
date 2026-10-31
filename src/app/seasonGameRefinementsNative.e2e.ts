import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { expect } from 'chai'

import { log, maestro } from '../../e2e/rigs/refinementsMaestro'

interface Node {
  type?: string
  text?: string
  id?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: Node[]
}
function flatten(node: Node): Node[] {
  return [node, ...(node.children ?? []).flatMap(flatten)]
}
async function main(): Promise<void> {
  const artifacts = process.env.TS_REFINEMENTS_ARTIFACTS
  const device = process.env.TS_REFINEMENTS_DEVICE
  const manifestPath = process.env.TS_REFINEMENTS_NATIVE_MANIFEST
  const packager = process.env.TS_REFINEMENTS_PACKAGER_PORT
  if (
    artifacts == null ||
    device == null ||
    !device.startsWith('emulator-') ||
    manifestPath == null ||
    packager == null
  )
    throw new Error(
      'Supply pinned owned Android simulator, native fixture manifest, artifacts and packager port'
    )
  expect(
    execFileSync('adb', ['-s', device, 'get-state'], {
      encoding: 'utf8'
    }).trim()
  ).equals('device')
  const owned = JSON.parse(
    await readFile(
      join(artifacts, 'support/android-owned-target-private.json'),
      'utf8'
    )
  ) as { device: string; appId: string; avd: string }
  if (owned.device !== device || owned.appId !== 'app.teamstation.app')
    throw new Error(
      'Supplied emulator must match this task owned-target metadata'
    )
  expect(
    execFileSync('adb', ['-s', device, 'emu', 'avd', 'name'], {
      encoding: 'utf8'
    })
      .trim()
      .split(/\r?\n/)[0]
  ).equals(owned.avd)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    origin: string
    season: string
    game: string
    managedGame: string
    teams: Record<string, string>
  }
  const daemon = await maestro(
    process.env.MAESTRO_D ?? 'seasonGameRefinementsAndroid'
  )
  const m = await daemon.attach({
    device,
    platform: 'android',
    appId: 'app.teamstation.app',
    appFile: resolve('android/app/build/outputs/apk/debug/app-debug.apk'),
    artifacts: 'on-failure',
    driverStartTimeout: 180,
    extra: { androidTcpForward: true }
  })
  await writeFile(
    join(artifacts, 'android-scenarios.log'),
    '$ node -r sucrase/register src/app/seasonGameRefinementsNative.e2e.ts\n'
  )
  const input = async (label: string, value: string): Promise<void> => {
    await m.scrollUntilVisible({
      element: { text: label.toUpperCase() },
      centerElement: true,
      timeout: 15000
    })
    let focused = false
    for (let attempt = 0; attempt < 5; attempt++) {
      const nodes = flatten(await m.hierarchy())
      const heading = nodes.find(
        n => n.text === label.toUpperCase() && n.bounds != null
      )
      const field = nodes
        .filter(
          n =>
            n.type === 'EditText' &&
            n.bounds != null &&
            heading?.bounds != null &&
            n.bounds.y >= heading.bounds.y
        )
        .sort((a, b) => a.bounds!.y - b.bounds!.y)[0]
      if (field?.bounds == null)
        throw new Error('Native field missing: ' + label)
      const width = Math.max(
        ...nodes.map(n => (n.bounds == null ? 0 : n.bounds.x + n.bounds.width))
      )
      const height = Math.max(
        ...nodes.map(n => (n.bounds == null ? 0 : n.bounds.y + n.bounds.height))
      )
      const top = Math.max(
        0,
        ...nodes
          .filter(
            n =>
              n.bounds != null &&
              n.bounds.y < height / 4 &&
              (n.text === 'Back' ||
                n.text === 'Notifications' ||
                n.text?.startsWith('Account,') === true)
          )
          .map(n => n.bounds!.y + n.bounds!.height)
      )
      const bottom = Math.min(
        height,
        ...nodes
          .filter(
            n =>
              n.bounds != null &&
              n.bounds.y > height / 2 &&
              ['Home', 'Videos', 'Schedule', 'Search'].includes(n.text ?? '')
          )
          .map(n => n.bounds!.y)
      )
      const center = field.bounds.y + field.bounds.height / 2
      if (center > bottom - 40) {
        await m.swipe({ start: '50%,75%', end: '50%,35%', duration: 400 })
        continue
      }
      if (center < top + 40) {
        await m.swipe({ start: '50%,35%', end: '50%,75%', duration: 400 })
        continue
      }
      await m.tapOn({
        point: `${(100 * (field.bounds.x + field.bounds.width / 2)) / width}%,${(100 * center) / height}%`
      })
      focused = true
      break
    }
    if (!focused)
      throw new Error('Native field obscured by navigation: ' + label)
    await m.eraseText({ characters: 250 })
    await m.inputText({ text: value })
    const entered = flatten(await m.hierarchy())
    expect(
      entered.some(n => n.type === 'EditText' && n.text === value),
      'Native field retains input: ' + label
    ).equals(true)
    if (entered.some(n => n.id?.includes('inputmethod') === true))
      await m.hideKeyboard()
  }
  const tap = async (text: string): Promise<void> => {
    if (text === 'Search') {
      await m.tapOn({ text, timeout: 15000 })
      return
    }
    try {
      await m.scrollUntilVisible({
        element: { text },
        centerElement: true,
        maxScrolls: 6,
        timeout: 7000
      })
    } catch {
      await m.scrollUntilVisible({
        element: { text },
        centerElement: true,
        direction: 'UP',
        maxScrolls: 20,
        timeout: 15000
      })
    }
    for (let attempt = 0; attempt < 4; attempt++) {
      const nodes = flatten(await m.hierarchy())
      const node = nodes.find(n => n.text === text && n.bounds != null)
      if (node?.bounds == null)
        throw new Error('Native action missing: ' + text)
      const height = Math.max(
        ...nodes.map(n => (n.bounds == null ? 0 : n.bounds.y + n.bounds.height))
      )
      const top = Math.max(
        0,
        ...nodes
          .filter(
            n =>
              n.bounds != null &&
              n.bounds.y < height / 4 &&
              (n.text === 'Back' ||
                n.text === 'Notifications' ||
                n.text?.startsWith('Account,') === true)
          )
          .map(n => n.bounds!.y + n.bounds!.height)
      )
      const bottom = Math.min(
        height,
        ...nodes
          .filter(
            n =>
              n.bounds != null &&
              n.bounds.y > height / 2 &&
              ['Home', 'Videos', 'Schedule', 'Search'].includes(n.text ?? '')
          )
          .map(n => n.bounds!.y)
      )
      const center = node.bounds.y + node.bounds.height / 2
      if (center < top + 24) {
        await m.swipe({ start: '50%,35%', end: '50%,75%', duration: 400 })
        continue
      }
      if (center > bottom - 24) {
        await m.swipe({ start: '50%,75%', end: '50%,35%', duration: 400 })
        continue
      }
      await m.tapOn({ text, timeout: 15000 })
      return
    }
    throw new Error('Native action is obscured by navigation: ' + text)
  }
  const show = async (text: string): Promise<void> => {
    await m.assertVisible({ text, timeout: 15000 })
  }
  const open = async (path: string): Promise<void> => {
    await m.openLink({ link: 'teamstation://' + path.replace(/^\//, '') })
  }
  const state = async (): Promise<any> =>
    await (await fetch(manifest.origin + '/__refinements/state')).json()
  const shot = async (name: string): Promise<void> => {
    await writeFile(join(artifacts, name), await m.screenshot())
  }
  try {
    // Provision only this task-owned simulator's synthetic app data and debug host.
    execFileSync(
      'adb',
      ['-s', device, 'shell', 'am', 'force-stop', 'app.teamstation.app'],
      { stdio: 'ignore' }
    )
    execFileSync(
      'adb',
      ['-s', device, 'shell', 'pm', 'clear', 'app.teamstation.app'],
      { stdio: 'ignore' }
    )
    execFileSync(
      'adb',
      [
        '-s',
        device,
        'shell',
        'run-as',
        'app.teamstation.app',
        'mkdir',
        '-p',
        'shared_prefs'
      ],
      { stdio: 'ignore' }
    )
    execFileSync(
      'adb',
      [
        '-s',
        device,
        'shell',
        'run-as app.teamstation.app sh -c "cat > /data/user/0/app.teamstation.app/shared_prefs/app.teamstation.app_preferences.xml"'
      ],
      {
        input: `<?xml version="1.0" encoding="utf-8"?><map><string name="debug_http_host">10.0.2.2:${packager}</string></map>`,
        stdio: ['pipe', 'ignore', 'ignore']
      }
    )
    await m.command('launchApp', {
      appId: 'app.teamstation.app',
      clearState: false
    })
    await input('E-mail address', 'alex@example.com')
    await tap('Send me a sign-in code')
    await show('.*six-digit code is on its way.*')
    const code = (
      await (
        await fetch(
          manifest.origin + '/__refinements/code?email=alex%40example.com'
        )
      ).json()
    ).code
    if (typeof code !== 'string')
      throw new Error('Synthetic code delivery missing')
    await input('Sign-in code', code)
    await tap('Sign in')
    await show('Search')
    await tap('Search')
    await show('Discover')
    await open(`/groups/season/${manifest.season}`)
    await show('In-Season')
    await tap('Schedule')
    await tap('Upcoming')
    await show('Pending approval')
    const pendingAction = flatten(await m.hierarchy()).find(
      n =>
        n.text?.includes('Demo Visitors') === true &&
        n.text.includes('Pending approval')
    )
    if (pendingAction?.text == null)
      throw new Error('Native pending schedule action is missing')
    await tap(pendingAction.text)
    await show('Withdraw invitation')
    await shot('android-pending-after.png')
    await open(`/groups/season/${manifest.season}`)
    await show('In-Season')
    await shot('android-season-after.png')
    await m.swipe({ direction: 'UP', duration: 450 })
    await show('Standings')
    await tap('Include Exhibitions')
    await show('.625')
    await m.swipe({ direction: 'UP', duration: 450 })
    const docked = flatten(await m.hierarchy()).find(
      n => n.id?.endsWith('sticky-season-sections') === true
    )
    if (docked?.bounds == null)
      throw new Error('Native season strip is missing')
    expect(docked.bounds.y).at.least(250)
    expect(docked.bounds.y).lessThan(400)
    const nameBefore = flatten(await m.hierarchy()).find(
      n => n.text === 'Demo Hawks'
    )
    expect(nameBefore?.bounds).not.equals(undefined)
    await m.swipe({ direction: 'LEFT', duration: 450 })
    await show('Demo Hawks')
    const afterTable = flatten(await m.hierarchy())
    const nameAfter = afterTable.find(n => n.text === 'Demo Hawks')
    expect(nameAfter?.bounds).not.equals(undefined)
    expect(nameAfter?.bounds?.x).equals(nameBefore?.bounds?.x)
    expect(afterTable.some(n => n.text === 'Away')).equals(true)
    await shot('android-standings-scroll-after.png')
    const sectionBounds = docked.bounds
    await m.swipe({
      startX: Math.round(sectionBounds.x + sectionBounds.width * 0.9),
      endX: Math.round(sectionBounds.x + sectionBounds.width * 0.1),
      startY: Math.round(sectionBounds.y + sectionBounds.height / 2),
      endY: Math.round(sectionBounds.y + sectionBounds.height / 2),
      duration: 450
    })
    const teamsTab = flatten(await m.hierarchy()).find(n => n.text === 'Teams')
    if (teamsTab?.bounds == null)
      throw new Error('Native Teams tab is missing after horizontal swipe')
    expect(teamsTab.bounds.x + teamsTab.bounds.width).at.most(
      sectionBounds.x + sectionBounds.width
    )
    await tap('Teams')
    await m.scrollUntilVisible({
      element: { text: 'EXHIBITION TEAMS' },
      centerElement: true,
      timeout: 15000
    })
    await show('EXHIBITION TEAMS')
    await m.scrollUntilVisible({
      element: { text: 'UNSCHEDULED' },
      centerElement: true,
      timeout: 15000
    })
    await show("These teams are in the season but don't have scheduled games.")
    await shot('android-teams-sections-after.png')
    await log(
      artifacts,
      'android-scenarios.log',
      'N1 PASS: Search, five season pills, sticky scroll, standings toggle and fixed names, team categories verified on owned portrait simulator'
    )

    await open(`/games/${manifest.game}/settings`)
    await show('Swap home and away')
    await shot('android-settings-after.png')
    const before = (await state()).games.find(
      (g: any) => g.id === manifest.game
    )
    await tap('Swap home and away')
    await tap('Cancel')
    expect(
      (await state()).games.find((g: any) => g.id === manifest.game)
    ).deep.equals(before)
    await open(`/games/${manifest.game}/settings`)
    await m.scrollUntilVisible({
      element: { text: 'Save' },
      centerElement: true,
      timeout: 15000
    })
    await show('Save')
    const count = (await state()).teams.length
    await tap('Demo Eagles')
    await tap('Create Placeholder Team')
    await input('Team name', 'Demo Native Preview')
    await tap('Continue')
    await tap('Skip')
    await tap('Skip')
    await tap('Cancel')
    expect((await state()).teams.length).equals(count)
    await open(`/games/${manifest.game}/settings`)
    await tap('Demo Eagles')
    await tap('Create Placeholder Team')
    await input('Team name', 'Demo Native Opponent')
    await tap('Continue')
    await tap('Skip')
    await tap('Skip')
    await tap('Save')
    await show('Game changes saved')
    await show('Demo Native Opponent')
    await m.scrollUntilVisible({
      element: { text: 'Event settings' },
      direction: 'UP',
      centerElement: true,
      timeout: 15000
    })
    await show('Event settings')
    const saved = await state()
    const placeholder = saved.teams.filter(
      (t: any) => t.name === 'Demo Native Opponent'
    )
    expect(placeholder).length(1)
    expect(placeholder[0]).includes({
      kind: 'external',
      custodian_type: 'team',
      custodian_id: manifest.teams.Hawks
    })
    expect(saved.games.find((g: any) => g.id === manifest.game)).includes({
      status: 'cancelled',
      cancellation_reason: 'replacement'
    })
    const newGame = saved.games.find(
      (g: any) => g.away_team_id === placeholder[0].id
    )
    expect(newGame.id).not.equals(manifest.game)
    expect(saved.gameReads).includes(newGame.id)
    await m.assertNotVisible({ text: 'Game changes saved', timeout: 8000 })
    await open(`/games/${newGame.id}/settings`)
    await tap('Withdraw Demo Hawks from game')
    await tap('Confirm withdrawal')
    await show('Game changes saved')
    expect(
      (await state()).games.find((g: any) => g.id === newGame.id)
    ).includes({
      status: 'cancelled',
      cancellation_reason: 'withdrawal',
      withdrawn_by_team_id: manifest.teams.Hawks
    })
    await log(
      artifacts,
      'android-scenarios.log',
      'N2 PASS: separate settings preview/Cancel and soft keyboard, no placeholder on Cancel, one custodian-held placeholder on Save, cancellation identity, proposal label, toast and explicit withdrawal verified'
    )
  } finally {
    await m.detach()
    await daemon.shutdown()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
