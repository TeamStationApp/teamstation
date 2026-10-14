import { execFileSync } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { expect } from 'chai'

import { log, maestro } from '../test/refinementsMaestro.e2e'

interface Node {
  type?: string
  text?: string
  value?: string
  bounds?: { x: number; y: number; width: number; height: number }
  children?: Node[]
}
const flatten = (node: Node): Node[] => [
  node,
  ...(node.children ?? []).flatMap(flatten)
]

/** Explicit task-owned iOS target; JS automation only, with real fixture mutations. */
async function main(): Promise<void> {
  const artifacts = process.env.TS_REFINEMENTS_ARTIFACTS
  const device = process.env.TS_REFINEMENTS_DEVICE
  const manifestPath = process.env.TS_REFINEMENTS_NATIVE_MANIFEST
  if (artifacts == null || device == null || manifestPath == null)
    throw new Error('Supply artifacts, owned iOS device and fixture manifest')
  const owned = JSON.parse(
    await readFile(
      join(artifacts, 'support/ios-owned-target-private.json'),
      'utf8'
    )
  ) as { device: string; name: string; appId: string }
  expect(owned.device).equals(device)
  expect(owned.name).equals('seasonStandingsTeamRestore iPhone')
  expect(owned.appId).equals('app.teamstation.app')
  const inventory = JSON.parse(
    execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], {
      encoding: 'utf8'
    })
  ) as { devices: Record<string, Array<{ udid: string }>> }
  expect(
    Object.values(inventory.devices)
      .flat()
      .some(d => d.udid === device)
  ).equals(true)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    origin: string
    season: string
    league: string
    game: string
    managedGame: string
    teams: Record<string, string>
  }
  const daemon = await maestro(process.env.MAESTRO_D ?? 'teamRestorationIOS')
  const m = await daemon.attach({
    device,
    platform: 'ios',
    appId: owned.appId,
    artifacts: 'on-failure',
    typingFrequency: 4,
    driverStartTimeout: 180
  })
  const from = process.env.TS_REFINEMENTS_NATIVE_FROM === '4' ? 4 : 1
  await mkdir(artifacts, { recursive: true })
  await (from === 4 ? appendFile : writeFile)(
    join(artifacts, 'ios-qa.log'),
    `$ ${from === 4 ? 'TS_REFINEMENTS_NATIVE_FROM=4 ' : ''}node -r sucrase/register src/app/teamRestorationIOS.e2e.ts\n`
  )
  const capture = async (name: string): Promise<void> => {
    await writeFile(join(artifacts, name), await m.screenshot())
  }
  const show = async (text: string): Promise<void> => {
    await m.assertVisible({ text, timeout: 15000 })
  }
  const tap = async (text: string): Promise<void> => {
    for (let attempt = 0; attempt < 10; attempt++) {
      await m.waitForAnimationToEnd()
      const tree = (await m.hierarchy()) as Node
      const viewport = tree.bounds
      if (viewport == null) throw new Error('Missing native viewport')
      const nodes = flatten(tree).filter(
        n => n.text === text && n.bounds != null
      )
      const target = nodes.find(
        n =>
          n.bounds!.y >= 112 &&
          n.bounds!.y + n.bounds!.height <= viewport.height * 0.85 &&
          n.bounds!.x >= 0 &&
          n.bounds!.x + n.bounds!.width <= viewport.width
      )
      if (target?.bounds != null) {
        if (
          target.type === 'Button' &&
          flatten(tree).some(n => n.type === 'Keyboard')
        ) {
          await m.hideKeyboard()
          continue
        }
        if (target.type === 'Button') {
          // Native labels are not accessibility identifiers. Resolve the
          // visible button by its label, preserving WDA's interactive targeting.
          await m.tapOn({ text, timeout: 15000 })
        } else {
          // Section tabs share names with global navigation. Use the observed
          // section control after animation has settled, preserving its scope.
          const { x, y, width, height } = target.bounds
          await m.tapOn({
            point: `${Math.round(x + width / 2)},${Math.round(y + height / 2)}`
          })
        }
        await m.waitForAnimationToEnd()
        return
      }
      const node = nodes[0]?.bounds
      if (node != null) {
        if (
          node.x + node.width > viewport.width &&
          node.y >= 112 &&
          node.y < viewport.height * 0.85
        ) {
          const y = (100 * (node.y + node.height / 2)) / viewport.height
          await m.swipe({ start: `90%,${y}%`, end: `35%,${y}%`, duration: 400 })
        } else
          await m.swipe({
            start: node.y < 112 ? '50%,30%' : '50%,70%',
            end: node.y < 112 ? '50%,70%' : '50%,30%',
            duration: 400
          })
      } else
        await m.scrollUntilVisible({
          element: { text },
          centerElement: true,
          timeout: 15000
        })
    }
    throw new Error(
      'Native control could not be positioned clear of header/nav: ' + text
    )
  }
  const input = async (label: string, value: string): Promise<void> => {
    await m.scrollUntilVisible({
      element: { text: label.toUpperCase() },
      centerElement: true,
      timeout: 15000
    })
    const tree = (await m.hierarchy()) as Node
    const nodes = flatten(tree)
    const field = nodes.find(
      n =>
        ['TextField', 'SecureTextField'].includes(n.type ?? '') &&
        n.text === label
    )
    if (field?.bounds == null || tree.bounds == null)
      throw new Error('Input field missing: ' + label)
    if (nodes.some(n => n.type === 'Button' && n.text === `Clear ${label}`))
      await tap(`Clear ${label}`)
    // Clear may scroll the native form; locate the current field again.
    await m.scrollUntilVisible({
      element: { text: label.toUpperCase() },
      centerElement: true,
      timeout: 15000
    })
    for (let attempt = 0; attempt < 8; attempt++) {
      await m.waitForAnimationToEnd()
      const currentTree = (await m.hierarchy()) as Node
      const all = flatten(currentTree)
      const currentField = all.find(
        n =>
          ['TextField', 'SecureTextField'].includes(n.type ?? '') &&
          n.text === label
      )
      if (currentField?.bounds == null || currentTree.bounds == null)
        throw new Error('Refreshed input field missing: ' + label)
      const { x, y, width, height } = currentField.bounds
      const keyboardTop = all.find(n => n.type === 'Keyboard')?.bounds?.y
      const bottom = Math.min(
        currentTree.bounds.height * 0.8,
        keyboardTop == null ? Infinity : keyboardTop - 12
      )
      if (
        y < 112 ||
        y + height > bottom ||
        x < 0 ||
        x + width > currentTree.bounds.width
      ) {
        const start = y < 112 ? 150 : bottom - 24
        const end = y < 112 ? bottom - 24 : 150
        await m.swipe({
          start: `50%,${(100 * start) / currentTree.bounds.height}%`,
          end: `50%,${(100 * end) / currentTree.bounds.height}%`,
          duration: 400
        })
        continue
      }
      await m.tapOn({ text: label, timeout: 15000 })
      await m.waitForAnimationToEnd()
      try {
        await m.inputText({ text: value })
      } catch (error) {
        // This driver failure guarantees no input was delivered; refocus
        // without duplicating partially typed text or hiding another failure.
        if (String(error).includes('no keyboard appeared') && attempt < 7)
          continue
        throw error
      }
      // The hierarchy omits TextField values; WDA assertions read the actual
      // native value and prove the input reached the visible field.
      await m.assertVisible({ text: value, timeout: 15000 })
      return
    }
    throw new Error(
      'Native input could not be positioned clear of header/nav/keyboard: ' +
        label
    )
  }
  const visit = async (path: string): Promise<void> => {
    await m.openLink({ link: 'teamstation://' + path.replace(/^\//, '') })
    await m.waitForAnimationToEnd()
  }
  const inspect = async (): Promise<any> => {
    const r = await fetch(manifest.origin + '/__refinements/state')
    expect(r.status).equals(200)
    return await r.json()
  }
  try {
    if (from === 1) {
      await m.launchApp()
      await m.assertVisible({ text: 'E-mail address', timeout: 60000 })
      // Text-field submission dismisses the iOS keyboard and submits sign-in.
      await input('E-mail address', 'alex@example.com')
      await m.hideKeyboard()
      await show('.*six-digit code.*')
      const response = await fetch(
        manifest.origin + '/__refinements/code?email=alex%40example.com'
      )
      const code = (await response.json()).code as string
      expect(code).matches(/^\d{6}$/)
      await input('Sign-in code', code)
      await m.hideKeyboard()
      await show('.*Demo Hawks.*')
      await m.tapOn({ text: 'Demo Hawks, Demo Regular · 2–1–1' })
      await show('Team')
      await show('Stats')
      await show('GAME VIDEO LIBRARY')
      await capture('ios-team-after.png')
      await tap('Schedule')
      await show('Pending approval')
      await tap('Team')
      await tap('Stats')
      await tap('Videos')
      await visit(`/groups/season/${manifest.season}`)
      await show('Standings')
      await capture('ios-ph-after.png')
      await m.scrollUntilVisible({
        element: { text: '.*PH means placeholder team.*' },
        centerElement: true,
        timeout: 15000
      })
      await show('.*PH means placeholder team.*')
      await m.scrollUntilVisible({
        element: { text: 'Open Demo Foxes' },
        centerElement: true,
        timeout: 15000
      })
      const beforeScroll = flatten((await m.hierarchy()) as Node).find(
        n => n.text === 'Open Demo Foxes'
      )?.bounds
      expect(beforeScroll).not.equals(undefined)
      const viewport = ((await m.hierarchy()) as Node).bounds!
      const y =
        (100 * (beforeScroll!.y + beforeScroll!.height / 2)) / viewport.height
      for (let i = 0; i < 4; i++)
        await m.swipe({ start: `90%,${y}%`, end: `52%,${y}%`, duration: 400 })
      await show('Placeholder team')
      expect(
        flatten((await m.hierarchy()) as Node).find(
          n => n.text === 'Open Demo Foxes'
        )?.bounds?.x
      ).equals(beforeScroll!.x)
      await capture('ios-ph-scroll-after.png')
      await tap('Include Exhibitions')
      await show('.625')
      await log(
        artifacts,
        'ios-qa.log',
        'N1 PASS: restored Home team shell/four tabs, pending card, PH/key and both standings filters'
      )
      await visit(`/teams/${manifest.teams.Hawks}?tab=schedule`)
      await tap('Manage')
      await show('TEAM MANAGEMENT')
      await input('Name', 'Demo Preview Name')
      await m.hideKeyboard()
      await tap('Cancel')
      await show('Demo Hawks')
      await show('Pending approval')
      await tap('Manage')
      await input('Name', 'Demo Renamed Hawks')
      await m.hideKeyboard()
      await tap('Save settings')
      await show('Demo Renamed Hawks')
      await show('Pending approval')
      await tap('Manage')
      await input('Name', 'Demo Hawks')
      await m.hideKeyboard()
      await tap('Save settings')
      await show('Demo Hawks')
      await visit(`/groups/team/${manifest.teams.Visitors}`)
      await show('.*membership is required.*')
      await tap('Team')
      await show('TEAM INFORMATION')
      await tap('Schedule')
      await show('SCHEDULE AND RESULTS')
      await tap('Stats')
      await show('.*membership is required.*')
      await log(
        artifacts,
        'ios-qa.log',
        'N2 PASS: gear-only management, Cancel/Save identity and tab return, visitor public/restricted sections'
      )
      await m.tapOn({ text: 'Search' })
      await show('Discover')
      await visit(`/groups/league/${manifest.league}`)
      await show('League settings')
      await tap('League settings')
      await show('Save settings')
      await visit(`/groups/season/${manifest.season}`)
      await tap('Season settings')
      await show('Save settings')
      await visit(`/groups/season/${manifest.season}?tab=teams`)
      await show('Teams')
      await m.scrollUntilVisible({
        element: { text: 'Unscheduled' },
        centerElement: true,
        timeout: 15000
      })
      await show('.*These teams are in the season.*')
      await log(
        artifacts,
        'ios-qa.log',
        'N3 PASS: league/season hero gears, season sections and Unscheduled explanation'
      )
    }
    await visit(`/games/${manifest.managedGame}/settings`)
    await show('Swap home and away')
    const before = await inspect()
    await tap('Swap home and away')
    await tap('Cancel')
    const canceled = await inspect()
    expect(canceled.games).deep.equals(before.games)
    await visit(`/games/${manifest.managedGame}/settings`)
    await tap('Save')
    await show('Game changes saved')
    await new Promise(resolve => setTimeout(resolve, 5500))
    await m.assertNotVisible({ text: 'Game changes saved' })
    await visit(`/games/${manifest.game}/settings`)
    await m.scrollUntilVisible({
      element: { text: 'Save' },
      centerElement: true,
      timeout: 15000
    })
    await show('Save')
    const count = (await inspect()).teams.length
    await tap('Demo Eagles')
    await tap('Create Placeholder Team')
    await show('TEAM NAME')
    await input('Team name', 'Demo iOS Preview')
    await m.hideKeyboard()
    await tap('Continue')
    await tap('Skip')
    await tap('Skip')
    await tap('Cancel')
    expect((await inspect()).teams.length).equals(count)
    await visit(`/games/${manifest.game}/settings`)
    await show('Demo Eagles')
    await tap('Demo Eagles')
    await tap('Create Placeholder Team')
    await show('TEAM NAME')
    await input('Team name', 'Demo iOS Opponent')
    await m.hideKeyboard()
    await tap('Continue')
    await tap('Skip')
    await tap('Skip')
    await tap('Save')
    await show('Game changes saved')
    const saved = await inspect()
    const placeholder = saved.teams.filter(
      (t: any) => t.name === 'Demo iOS Opponent'
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
    const replacement = saved.games.find(
      (g: any) => g.away_team_id === placeholder[0].id
    )
    expect(replacement.id).not.equals(manifest.game)
    await visit(`/games/${replacement.id}/settings`)
    await tap('Withdraw Demo Hawks from game')
    await tap('Confirm withdrawal')
    await show('Game changes saved')
    expect(
      (await inspect()).games.find((g: any) => g.id === replacement.id)
    ).includes({
      status: 'cancelled',
      cancellation_reason: 'withdrawal',
      withdrawn_by_team_id: manifest.teams.Hawks
    })
    await log(
      artifacts,
      'ios-qa.log',
      'N4 PASS: separate settings, draft swap canceled without mutation, Save/proposal authority, default placeholder custody, original cancellation/distinct replacement, attributed unilateral withdrawal, success toast and five-second expiry'
    )
  } catch (error) {
    await capture('support/ios-failure-private.png')
    await writeFile(
      join(artifacts, 'support/ios-failure-hierarchy-private.json'),
      JSON.stringify(await m.hierarchy(), null, 2)
    )
    await log(
      artifacts,
      'ios-qa.log',
      'FAIL: assertion or native driver step failed'
    )
    throw error
  } finally {
    await m.detach()
    await daemon.shutdown()
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
