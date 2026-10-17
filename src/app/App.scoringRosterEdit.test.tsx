import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { TeamStationClient } from '../common/api'
import { App } from './App'
import { currentRoute, showRoute } from './navigation/useAddressBar'
import { rosterEditFixture } from './scoring/scoringRosterEdit.e2e.fixture'
import { ServerScoringSource } from './scoring/scoringSource'

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 80))
  })
}
const press = async (label: string): Promise<void> => {
  const find = (): HTMLElement | undefined => [
    ...document.querySelectorAll<HTMLElement>(
      '[role="button"], [role="tab"], [role="radio"], [role="checkbox"]'
    )
  ].find(node => node.getAttribute('aria-label')?.startsWith(label) === true)
  // Returning from Settings reloads the roster; wait for its actual row.
  await waitFor(() => find() != null)
  const element = find()
  expect(element, label).not.equals(undefined)
  await act(async () => {
    element!.click()
  })
  await settle()
}
const type = async (label: string, value: string): Promise<void> => {
  await waitFor(() => document.querySelector(`[aria-label="${label}"]`) != null)
  const input = document.querySelector<HTMLInputElement>(
    `[aria-label="${label}"]`
  )!
  expect(input, label).not.equals(null)
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  await settle()
}

const waitFor = async (check: () => boolean): Promise<void> => {
  for (let count = 0; count < 80 && !check(); count++) await settle()
  expect(check()).equals(true)
}
const withScoringApp = async (
  check: (
    fixture: Awaited<ReturnType<typeof rosterEditFixture>>
  ) => Promise<void>,
  prepare?: (
    fixture: Awaited<ReturnType<typeof rosterEditFixture>>
  ) => Promise<void>
): Promise<void> => {
  const fixture = await rosterEditFixture('http://127.0.0.1:1', 0)
  showRoute({ name: 'game', gameId: fixture.gameId }, true)
  showRoute({ name: 'scoreGame', gameId: fixture.gameId })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await prepare?.(fixture)
    await act(async () => {
      root.render(<App apiBaseUrl={fixture.url + '/api/v1'} />)
    })
    await waitFor(
      () => document.querySelector('[aria-label="Open scoring menu"]') != null
    )
    await check(fixture)
  } finally {
    fixture.pauseSettings(false)
    fixture.pauseSettingsResponses(false)
    fixture.pauseRoleReads(false)
    fixture.pauseWrites(false)
    await act(async () => {
      root.unmount()
    })
    host.remove()
    await fixture.close()
  }
}
const openEditor = async (): Promise<void> => {
  await press('Open scoring menu')
  await press('Set Team Rosters')
  await press('Roster')
  await waitFor(
    () =>
      document.querySelector('[aria-label="Loading team roster"]') == null &&
      document.querySelector('[aria-label^="Mookie Betts,"]') != null
  )
}

describe('actual App scoring player Settings return', function () {
  for (const role of ['scorekeeper', 'admin'] as const) {
    it(`defaults a home-only ${role} to the home roster and retains their chosen side after Settings`, async function () {
      await withScoringApp(
        async () => {
          await openEditor()
          expect(
            document
              .querySelector('[aria-label="Home Team"]')
              ?.getAttribute('aria-selected')
          ).equals('true')
          await press('Away Team')
          expect(
            document
              .querySelector('[aria-label="Away Team"]')
              ?.getAttribute('aria-selected')
          ).equals('true')
          await press('Home Team')
          await press('Mookie Betts,')
          await waitFor(
            () => document.body.textContent?.includes('JERSEY NUMBER') === true
          )
          await press('Back')
          await waitFor(
            () => document.querySelector('[aria-label="Home Team"]') != null
          )
          expect(
            document
              .querySelector('[aria-label="Home Team"]')
              ?.getAttribute('aria-selected')
          ).equals('true')
        },
        async fixture => {
          await fixture.roles([role], 'team', ['home'])
        }
      )
    })
  }
  it('keeps server values when an older write finishes before a newer visit reply', async function () {
    await withScoringApp(async fixture => {
      await openEditor()
      await press('Mookie Betts,')
      await type('Jersey number', '14')
      fixture.pauseSettings(true)
      await press('Save')
      await waitFor(() =>
        fixture.trace.some(line => line.startsWith('Pending settings PUT'))
      )
      await press('Stats')
      await press('Player settings')
      fixture.pauseSettings(false, false)
      fixture.pauseSettingsResponses(true)
      await type('Jersey number', '15')
      await press('Save')
      await waitFor(() =>
        fixture.trace.some(line => line.startsWith('Captured settings PUT'))
      )
      // B has committed, but only A's later write may respond yet.
      fixture.pauseSettingsResponses(false, false)
      fixture.pauseSettings(false)
      await waitFor(() =>
        fixture.trace.some(
          line =>
            line.includes('"jersey":"14"') &&
            line.includes('PUT') &&
            line.includes('-> 200')
        )
      )
      await press('Back')
      await waitFor(
        () =>
          document.querySelector('[aria-label="Loading team roster"]') ==
            null &&
          document.querySelector('[aria-label^="Mookie Betts, jersey 14"]') !=
            null
      )
      fixture.pauseSettingsResponses(false)
      await waitFor(
        () =>
          fixture.trace.filter(
            line =>
              line.includes('PUT') &&
              line.includes('"jersey":"15"') &&
              line.includes('-> 200')
          ).length === 1
      )
      await waitFor(
        () =>
          document.querySelector('[aria-label="Loading team roster"]') ==
            null &&
          document.querySelector('[aria-label^="Mookie Betts, jersey 14"]') !=
            null
      )
      const server = new TeamStationClient({
        baseUrl: fixture.backendUrl + '/api/v1'
      })
      expect(
        (await server.roster('away')).find(row => row.userId === 100)?.jersey
      ).equals('14')
      expect(
        document.querySelector('[aria-label^="Mookie Betts, jersey 15"]')
      ).equals(null)
    })
  })
  it('keeps a complete lineup when private roster access is revoked during initial loading', async function () {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Restored below and called with the live client.
    const roster = TeamStationClient.prototype.roster
    try {
      await withScoringApp(
        async () => {
          await press('Open scoring menu')
          await press('Set Team Rosters')
          expect(
            document.querySelector('[aria-label="Remove Mookie B"]')
          ).not.equals(null)
          await press('Roster')
          await waitFor(
            () =>
              document.querySelector('[aria-label="Loading team roster"]') ==
              null
          )
          expect(document.body.textContent).not.includes('Mookie Betts')
          expect(document.body.textContent).includes(
            'Player settings are unavailable for this team.'
          )
        },
        async fixture => {
          let revoked = false
          TeamStationClient.prototype.roster = async function (
            teamId,
            options
          ) {
            if (
              !revoked &&
              teamId === 'away' &&
              options?.includeFullNames === true
            ) {
              revoked = true
              await fixture.roles(['songkeeper'])
            }
            return await roster.call(this, teamId, options)
          }
        }
      )
    } finally {
      TeamStationClient.prototype.roster = roster
    }
  })
  it('shares one leave decision across repeated Home taps and recovers after Cancel', async function () {
    await withScoringApp(async fixture => {
      fixture.pauseWrites(true)
      await press('Ball')
      await openEditor()
      await press('Lineup')
      await press('Remove Aaron J')
      await press('Roster')
      await press('Mookie Betts,')
      await waitFor(
        () => document.body.textContent?.includes('JERSEY NUMBER') === true
      )
      await press('Home')
      await press('Home')
      await waitFor(
        () => document.querySelector('[aria-label="Discard and Exit"]') != null
      )
      await press('Cancel')
      expect(document.querySelector('[aria-label="Discard and Exit"]')).equals(
        null
      )
      expect(currentRoute()).includes({ name: 'player', userId: '100' })
      expect(document.body.textContent).includes('JERSEY NUMBER')
      await press('Back')
      await press('Lineup')
      expect(document.querySelector('[aria-label="Remove Aaron J"]')).equals(
        null
      )
      await press('Roster')
      await press('Mookie Betts,')
      await waitFor(
        () => document.body.textContent?.includes('JERSEY NUMBER') === true
      )
      await press('Home')
      await waitFor(
        () => document.querySelector('[aria-label="Discard and Exit"]') != null
      )
      await press('Discard and Exit')
      await waitFor(() => currentRoute().name === 'home')
    })
  })
  it('protects Notifications navigation while scoring writes are pending', async function () {
    await withScoringApp(async fixture => {
      fixture.pauseWrites(true)
      await press('Ball')
      await openEditor()
      await press('Mookie Betts,')
      await press('Notifications')
      await waitFor(
        () => document.querySelector('[aria-label="Discard and Exit"]') != null
      )
      await press('Cancel')
      expect(currentRoute()).includes({ name: 'player', userId: '100' })
      expect(document.body.textContent).includes('JERSEY NUMBER')
      await press('Notifications')
      await waitFor(
        () => document.querySelector('[aria-label="Discard and Exit"]') != null
      )
      await press('Discard and Exit')
      await waitFor(() => currentRoute().name === 'notifications')
      await press('Back')
      await waitFor(() => currentRoute().name === 'home')
      expect(document.querySelector('[aria-label="Open scoring menu"]')).equals(
        null
      )
    })
  })
  it('ignores a prior scorer lifetime reply after reopening the same game', async function () {
    await withScoringApp(async fixture => {
      await openEditor()
      await press('Mookie Betts,')
      await type('Jersey number', '14')
      fixture.pauseSettingsResponses(true)
      await press('Save')
      await waitFor(() =>
        fixture.trace.some(line => line.startsWith('Captured settings PUT'))
      )
      await press('Stats')
      await press('Player settings')
      fixture.pauseSettingsResponses(false, false)
      await type('Jersey number', '15')
      await press('Save')
      await waitFor(() =>
        fixture.trace.some(
          line =>
            line.includes('"jersey":"15"') &&
            line.includes('PUT') &&
            line.includes('-> 200')
        )
      )
      await press('Back')
      await waitFor(
        () =>
          document.querySelector('[aria-label="Loading team roster"]') == null
      )
      await press('Cancel')
      await press('Open scoring menu')
      await press('Exit Current Game')
      await waitFor(() => currentRoute().name === 'game')
      await press('Score')
      await press('Full game scoring')
      await waitFor(
        () => document.querySelector('[aria-label="Open scoring menu"]') != null
      )
      await openEditor()
      await press('Mookie Betts,')
      await press('Back')
      await waitFor(
        () =>
          document.querySelector('[aria-label="Loading team roster"]') == null
      )
      fixture.pauseSettingsResponses(false)
      await settle()
      await settle()
      expect(
        document.querySelector('[aria-label^="Mookie Betts, jersey 15"]')
      ).not.equals(null)
      expect(
        document.querySelector('[aria-label^="Mookie Betts, jersey 14"]')
      ).equals(null)
    })
  })
  it('rechecks shell permissions before opening Settings after a roster role is granted', async function () {
    await withScoringApp(
      async fixture => {
        await openEditor()
        await fixture.roles(['scorekeeper'])
        await press('Cancel')
        await openEditor()
        await press('Home')
        await waitFor(
          () =>
            document.querySelector('[aria-label="Loading team roster"]') == null
        )
        expect(
          document
            .querySelector('[aria-label^="Mookie Betts,"]')
            ?.getAttribute('aria-disabled')
        ).not.equals('true')
        fixture.pauseRoleReads(true)
        await press('Mookie Betts,')
        expect(currentRoute()).includes({
          name: 'player',
          userId: '200',
          onTeam: 'home',
          tab: 'settings'
        })
        expect(document.body.textContent).not.includes('JERSEY NUMBER')
        fixture.pauseRoleReads(false)
        await waitFor(
          () => document.body.textContent?.includes('JERSEY NUMBER') === true
        )
        expect(document.body.textContent).includes('Mookie Betts')
        expect(currentRoute()).includes({ tab: 'settings', onTeam: 'home' })
      },
      async fixture => {
        await fixture.roles(['scorekeeper'], 'team', ['away'])
      }
    )
  })
  it('keeps own-team editing when the opponent roster is read without private names', async function () {
    await withScoringApp(async fixture => {
      await fixture.roles(['scorekeeper'], 'team', ['away'])
      await openEditor()
      // Anybody signed in reads another team's roster, short names only, so
      // the opponent's is there without the right to manage it.
      expect(
        fixture.trace.some(
          line =>
            line.includes('/teams/home/roster ') && line.includes('-> 200')
        )
      ).equals(true)
      expect(
        document
          .querySelector('[aria-label^="Mookie Betts,"]')
          ?.getAttribute('aria-disabled')
      ).not.equals('true')
      await press('Home')
      expect(document.body.textContent).includes(
        'Player settings are unavailable for this team.'
      )
      expect(document.body.textContent).not.includes('Bryce Harper')
      await press('Away')
      await press('Mookie Betts,')
      await waitFor(
        () => document.body.textContent?.includes('JERSEY NUMBER') === true
      )
    })
  })
  it('returns browser Back across player tabs to the roster and Forward reopens the last tab', async function () {
    await withScoringApp(async () => {
      await openEditor()
      await press('Mookie Betts,')
      await press('Stats')
      await act(async () => {
        window.history.back()
      })
      await waitFor(() => currentRoute().name === 'scoreGame')
      await waitFor(
        () =>
          document.querySelector('[aria-label="Loading team roster"]') == null
      )
      expect(document.body.textContent).includes(
        'Tap a player to edit settings.'
      )
      await act(async () => {
        window.history.forward()
      })
      await waitFor(() => currentRoute().name === 'player')
      expect(currentRoute()).includes({
        userId: '100',
        onTeam: 'away',
        tab: 'stats'
      })
    })
  })
  it('restores a scrolled web roster after visiting player Settings', async function () {
    await withScoringApp(async () => {
      await openEditor()
      const list = document.querySelector<HTMLElement>(
        '[data-testid="Edit roster players"]'
      )!
      expect(list).not.equals(null)
      await act(async () => {
        list.scrollTop = 211
        list.dispatchEvent(new window.Event('scroll'))
        await new Promise(resolve => setTimeout(resolve, 150))
      })
      await press('Mookie Betts,')
      await waitFor(
        () => document.body.textContent?.includes('JERSEY NUMBER') === true
      )
      await press('Back')
      await waitFor(
        () =>
          document.querySelector('[aria-label="Loading team roster"]') == null
      )
      const returned = document.querySelector<HTMLElement>(
        '[data-testid="Edit roster players"]'
      )!
      expect(returned.scrollTop).equals(211)
    })
  })
  it('hides cached full names throughout a pending return permission recheck', async function () {
    await withScoringApp(async fixture => {
      await openEditor()
      await press('Mookie Betts,')
      await waitFor(
        () => document.body.textContent?.includes('JERSEY NUMBER') === true
      )
      await fixture.roles([])
      fixture.pauseRoleReads(true)
      await press('Back')
      await waitFor(() => fixture.trace.includes('Captured roles GET'))
      expect(document.body.textContent).not.includes('Mookie Betts')
      expect(document.querySelector('[aria-label^="Mookie B,"]')).not.equals(
        null
      )
      fixture.pauseRoleReads(false)
      await waitFor(
        () =>
          document.body.textContent?.includes(
            'Player settings are unavailable for this team.'
          ) === true
      )
      expect(document.body.textContent).not.includes('Mookie Betts')
    })
  })
  for (const [back, delayedCommit] of [
    [true, false],
    [false, false],
    [false, true]
  ] as const)
    it(
      delayedCommit
        ? 'reconciles server values when an older Settings request commits after the newer save'
        : `keeps the newer save when an older Settings reply arrives after ${back ? 'a repeated visit' : 'switching player tabs'}`,
      async function () {
        await withScoringApp(async fixture => {
          await openEditor()
          await press('Mookie Betts,')
          await type('Jersey number', '14')
          const pauseSave = delayedCommit
            ? fixture.pauseSettings
            : fixture.pauseSettingsResponses
          pauseSave(true)
          await press('Save')
          await waitFor(() =>
            fixture.trace.some(line =>
              line.startsWith(
                delayedCommit ? 'Pending settings PUT' : 'Captured settings PUT'
              )
            )
          )
          if (back) {
            await press('Back')
            await waitFor(
              () =>
                document.querySelector('[aria-label="Loading team roster"]') ==
                  null &&
                document.querySelector(
                  '[aria-label^="Mookie Betts, jersey 14"]'
                ) != null
            )
          } else {
            await press('Stats')
            await press('Player settings')
          }
          pauseSave(false, false)
          if (back) await press('Mookie Betts,')
          await type('Jersey number', '15')
          await press('Save')
          await waitFor(() =>
            fixture.trace.some(
              line =>
                line.includes('PUT /api/v1/teams/away/players/100/settings') &&
                line.includes('"jersey":"15"') &&
                line.includes('-> 200')
            )
          )
          await press('Back')
          await waitFor(
            () =>
              document.querySelector(
                '[aria-label^="Mookie Betts, jersey 15,"]'
              ) != null
          )
          pauseSave(false)
          const expected = delayedCommit ? '14,' : '15,'
          await waitFor(
            () =>
              document.querySelector('[aria-label="Loading team roster"]') ==
                null &&
              document.querySelector(
                `[aria-label^="Mookie Betts, jersey ${expected}"]`
              ) != null
          )
          expect(
            document.querySelector(
              `[aria-label^="Mookie Betts, jersey ${expected}"]`
            )
          ).not.equals(null)
          if (!delayedCommit)
            expect(
              document.querySelector('[aria-label^="Mookie Betts, jersey 14"]')
            ).equals(null)
        })
      }
    )
  it('keeps the browser exit guard live through Discard and cancels back to the same roster', async function () {
    await withScoringApp(async fixture => {
      fixture.pauseWrites(true)
      await press('Ball')
      await openEditor()
      await act(async () => {
        window.history.back()
      })
      await waitFor(
        () => document.querySelector('[aria-label="Discard and Exit"]') != null
      )
      await press('Cancel')
      expect(document.body.textContent).includes(
        'Tap a player to edit settings.'
      )
      await act(async () => {
        window.history.back()
      })
      await waitFor(
        () => document.querySelector('[aria-label="Discard and Exit"]') != null
      )
      await press('Discard and Exit')
      await waitFor(() => currentRoute().name === 'scoreOptions')
      expect(currentRoute()).includes({
        name: 'scoreOptions',
        gameId: fixture.gameId
      })
    })
  })
  it('keeps names hidden when Save finishes during a revoked-role recheck', async function () {
    const fixture = await rosterEditFixture('http://127.0.0.1:1', 0)
    showRoute({ name: 'scoreGame', gameId: fixture.gameId }, true)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(<App apiBaseUrl={fixture.url + '/api/v1'} />)
      })
      for (
        let count = 0;
        count < 30 &&
        document.querySelector('[aria-label="Open scoring menu"]') == null;
        count++
      )
        await settle()
      await press('Open scoring menu')
      await press('Set Team Rosters')
      await press('Roster')
      await press('Mookie Betts,')
      await type('Jersey number', '16')
      fixture.pauseSettingsResponses(true)
      await press('Save')
      for (
        let count = 0;
        count < 30 &&
        !fixture.trace.some(line => line.startsWith('Captured settings PUT'));
        count++
      )
        await settle()
      expect(
        fixture.trace.some(line => line.startsWith('Captured settings PUT'))
      ).equals(true)
      await fixture.roles([])
      fixture.pauseRoleReads(true)
      await press('Back')
      for (
        let count = 0;
        count < 30 && !fixture.trace.includes('Captured roles GET');
        count++
      )
        await settle()
      expect(fixture.trace.includes('Captured roles GET')).equals(true)
      fixture.pauseSettingsResponses(false)
      await waitFor(() =>
        fixture.trace.some(
          line =>
            line.includes('PUT') &&
            line.includes('"jersey":"16"') &&
            line.includes('-> 200')
        )
      )
      expect(document.body.textContent).not.includes('Mookie Betts')
      expect(document.querySelector('[aria-label^="Mookie B,"]')).not.equals(
        null
      )
      fixture.pauseRoleReads(false)
      await waitFor(
        () =>
          document.querySelector('[aria-label="Loading team roster"]') == null
      )
      expect(document.body.textContent).not.includes('Mookie Betts')
      expect(document.querySelector('[aria-label^="Mookie B,"]')).not.equals(
        null
      )
      expect(document.body.textContent).includes(
        'Player settings are unavailable for this team.'
      )
    } finally {
      fixture.pauseSettingsResponses(false)
      fixture.pauseRoleReads(false)
      await act(async () => {
        root.unmount()
      })
      host.remove()
      await fixture.close()
    }
  })

  it('accepts a late Save after Back, rejects an older roster read, recovers refresh failures and clears revoked names', async function () {
    const fixture = await rosterEditFixture('http://127.0.0.1:1', 0)
    showRoute({ name: 'scoreGame', gameId: fixture.gameId }, true)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(<App apiBaseUrl={fixture.url + '/api/v1'} />)
      })
      for (
        let count = 0;
        count < 30 &&
        document.querySelector('[aria-label="Open scoring menu"]') == null;
        count++
      )
        await settle()
      await press('Open scoring menu')
      await press('Set Team Rosters')
      await press('Roster')
      await press('Mookie Betts,')
      await type('Jersey number', '15')
      fixture.pauseSettings(true)
      await press('Save')
      fixture.pauseRosterReads(true)
      await press('Back')
      for (
        let count = 0;
        count < 30 &&
        !fixture.trace.some(line => line.startsWith('Captured roster GET'));
        count++
      )
        await settle()
      expect(
        fixture.trace.some(line => line.startsWith('Captured roster GET'))
      ).equals(true)
      // Keep the captured stale read held while permitting fresh reads.
      fixture.pauseRosterReads(false, false)
      fixture.pauseSettings(false)
      for (
        let count = 0;
        count < 30 &&
        document.querySelector('[aria-label^="Mookie Betts, jersey 15"]') ==
          null;
        count++
      )
        await settle()
      expect(
        document.querySelector('[aria-label^="Mookie Betts, jersey 15"]')
      ).not.equals(null)
      fixture.pauseRosterReads(false)
      await settle()
      await settle()
      expect(
        document.querySelector('[aria-label^="Mookie Betts, jersey 15"]')
      ).not.equals(null)
      await press('Mookie Betts,')
      fixture.rosterFailure(true)
      await press('Back')
      expect(document.body.textContent).includes(
        'Unable to refresh the roster.'
      )
      expect(document.body.textContent).includes('Mookie Betts')
      fixture.rosterFailure(false)
      await press('Retry loading roster')
      expect(document.body.textContent).not.includes(
        'Unable to refresh the roster.'
      )
      await fixture.roles([])
      await press('Mookie Betts,')
      await press('Back')
      expect(document.body.textContent).not.includes('Mookie Betts')
      expect(
        document.querySelector('[aria-label^="Mookie B, jersey 15"]')
      ).not.equals(null)
    } finally {
      fixture.pauseSettings(false)
      fixture.pauseRosterReads(false)
      await act(async () => {
        root.unmount()
      })
      host.remove()
      await fixture.close()
    }
  })

  this.timeout(60000)
  it('keeps the scoring session, roster draft and Undo across a light Settings save and both history directions', async function () {
    const fixture = await rosterEditFixture('http://127.0.0.1:1', 0)
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Restored below and invoked with the live instance via apply.
    const original = ServerScoringSource.prototype.open
    let opens = 0
    ServerScoringSource.prototype.open = async function (...args) {
      opens++
      return await original.apply(this, args)
    }
    showRoute({ name: 'scoreGame', gameId: fixture.gameId }, true)
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(<App apiBaseUrl={fixture.url + '/api/v1'} />)
      })
      for (
        let count = 0;
        count < 30 &&
        document.querySelector('[aria-label="Open scoring menu"]') == null;
        count++
      )
        await settle()
      expect(opens).equals(1)
      await press('Ball')
      await press('Open scoring menu')
      await press('Set Team Rosters')
      await press('Remove Aaron J')
      await press('Roster')
      await press('Mookie Betts,')
      expect(currentRoute()).includes({
        name: 'player',
        userId: '100',
        onTeam: 'away',
        tab: 'settings'
      })
      await waitFor(
        () =>
          document.body.textContent?.includes('JERSEY NUMBER') === true &&
          document.body.textContent.includes('Mookie Betts')
      )
      expect(document.body.textContent)
        .includes('JERSEY NUMBER')
        .and.includes('Mookie Betts')
      const scoring = JSON.stringify(fixture.stored())
      await type('Jersey number', '12')
      document.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'b', bubbles: true })
      )
      // Settings beside a team edits the jersey and positions; how a player
      // bats and throws is edited away from a team.
      await press('SS')
      await press('Save')
      expect(JSON.stringify(fixture.stored())).equals(scoring)
      await press('Back')
      await settle()
      expect(currentRoute()).includes({
        name: 'scoreGame',
        gameId: fixture.gameId
      })
      expect(document.body.textContent).includes(
        'Tap a player to edit settings.'
      )
      await waitFor(
        () =>
          document.querySelector(
            '[aria-label^="Mookie Betts, jersey 12, bats right, throws right"]'
          ) != null
      )
      expect(
        document.querySelector(
          '[aria-label^="Mookie Betts, jersey 12, bats right, throws right"]'
        )
      ).not.equals(null)
      expect(opens).equals(1)
      await act(async () => {
        window.history.forward()
        await new Promise(resolve => setTimeout(resolve, 100))
      })
      await settle()
      expect(currentRoute()).includes({ name: 'player', userId: '100' })
      expect(document.body.textContent).includes('JERSEY NUMBER')
      await press('Stats')
      await press('Back')
      await settle()
      expect(currentRoute()).includes({ name: 'scoreGame' })
      await press('Lineup')
      expect(document.querySelector('[aria-label="Remove Aaron J"]')).equals(
        null
      )
      await press('Cancel')
      expect(document.querySelector('[aria-label^="Undo Ball"]')).not.equals(
        null
      )
      expect(opens).equals(1)
    } finally {
      await act(async () => {
        root.unmount()
      })
      host.remove()
      ServerScoringSource.prototype.open = original
      await fixture.close()
    }
  })
  it('drops a scorekeeper’s draft on Cancel, and Save Rosters applies it as one Undo step and closes', async function () {
    await withScoringApp(async () => {
      const saveDisabled = (): string | null | undefined =>
        document
          .querySelector('[aria-label="Save Rosters"]')
          ?.getAttribute('aria-disabled')
      await openEditor()
      await press('Lineup')
      // The game has recorded nothing: its lineups wait to be accepted, so
      // Save is lit before any change.
      expect(saveDisabled()).equals(null)
      await press('Remove Aaron J')
      expect(saveDisabled()).equals(null)
      await press('Cancel')
      expect(document.querySelector('[aria-label="Save Rosters"]')).equals(null)
      // The draft went with the sheet: Judge bats again.
      await press('Open scoring menu')
      await press('Set Team Rosters')
      await press('Lineup')
      expect(
        document.querySelector('[aria-label="Remove Aaron J"]')
      ).not.equals(null)
      expect(saveDisabled()).equals(null)
      await press('Remove Aaron J')
      await press('Save Rosters')
      expect(document.querySelector('[aria-label="Save Rosters"]')).equals(null)
      expect(
        document.querySelector('[aria-label^="Undo Set team roster"]')
      ).not.equals(null)
      await press('Open scoring menu')
      await press('Set Team Rosters')
      await press('Lineup')
      expect(document.querySelector('[aria-label="Remove Aaron J"]')).equals(
        null
      )
      // Saved, the lineup is the game's: Save waits for a change.
      expect(saveDisabled()).equals('true')
      await press('Add Aaron J to Lineup')
      expect(saveDisabled()).equals(null)
      await press('Cancel')
    })
  })
})
