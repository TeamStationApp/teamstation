import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { ExistingPlayerAnswer, RosterEntry } from '../../common/api'
import { HttpError } from '../../common/errors'
import type { ExistingRosterPlayer } from '../../common/playerSettings'
import { candidate, FakeCandidateClient } from '../../test/fakeCandidateClient'
import { heldTimers } from '../../test/fakeScreenScope'
import { measureBoxes } from '../../test/measureBoxes'
import { scoringSession } from '../../test/scoringSession'
import { ThemeProvider } from '../theme/ThemeContext'
import { gameFixture } from './isUnscoredGame.test'
import { RosterEditor } from './RosterEditor'
import { initialScoringState } from './scoringMachine'
import type { ScoringSessionState, Side } from './scoringTypes'

/**
 * Add Existing Player from Set Team Rosters: the search, Add to Roster and
 * Add as Pool Player, and what each answer leaves in the draft.
 */
let root: Root | undefined
let timers: ReturnType<typeof heldTimers> | undefined
let restoreRects: (() => void) | undefined
const node = (label: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
const text = (): string => document.body.textContent ?? ''
async function click(label: string): Promise<void> {
  const found = node(label)
  expect(found, label).not.equals(null)
  await act(async () => {
    found!.click()
  })
}
async function input(label: string, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(node(label), value)
    node(label)!.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

const betts = candidate('Mookie Betts', {
  userId: 'usr_betts',
  bats: 'right',
  throws: 'right',
  teams: [{ teamId: 'tem_dodgers', name: 'Ridgeview Dodgers' }]
})
const entryOf = (gumboId: number): RosterEntry =>
  ({
    userId: 'usr_betts',
    gumboId,
    isPlayer: true,
    shortName: 'Mookie B',
    jersey: '50',
    positions: ['SS'],
    bats: 'right',
    throws: 'right',
    externalIds: []
  }) as unknown as RosterEntry

interface Sent {
  roster: Array<{ teamId: string; body: ExistingRosterPlayer }>
  guest: Array<{ side: Side; body: ExistingRosterPlayer }>
  saved: ScoringSessionState[]
}

async function open({
  rights,
  roster = async () => ({ entry: entryOf(9001), noticeId: 'req_1' }),
  guest = async () => ({ entry: entryOf(9002), noticeId: null }),
  withClient = true
}: {
  rights?: Record<string, boolean>
  roster?: () => Promise<ExistingPlayerAnswer>
  guest?: () => Promise<ExistingPlayerAnswer>
  withClient?: boolean
} = {}): Promise<{ sent: Sent; fake: FakeCandidateClient }> {
  timers = heldTimers(500)
  restoreRects?.()
  restoreRects = measureBoxes()
  const fake = new FakeCandidateClient()
  const sent: Sent = { roster: [], guest: [], saved: [] }
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <RosterEditor
          state={initialScoringState(scoringSession(gameFixture))}
          {...(rights == null ? {} : { canEditTeams: rights })}
          {...(withClient ? { client: fake.client } : {})}
          onAddExistingRosterPlayer={async (teamId, body) => {
            sent.roster.push({ teamId, body })
            return await roster()
          }}
          onAddExistingGuest={async (side, body) => {
            sent.guest.push({ side, body })
            return await guest()
          }}
          onCreateGuest={async () => entryOf(9100 + sent.guest.length)}
          onSave={draft => {
            sent.saved.push(draft)
          }}
        />
      </ThemeProvider>
    )
  })
  return { sent, fake }
}
/** Opens the search, answers it with Betts, and chooses him. */
async function chooseBetts(fake: FakeCandidateClient): Promise<void> {
  await click('Add Existing Player')
  expect(text()).includes('Add Existing Player')
  expect(fake.last()).to.include({ teamId: 'away', gameId: 'g1' })
  await act(async () => {
    fake.last().resolve([betts])
  })
  await click('Choose Mookie B')
}

describe('adding an existing player in Set Team Rosters', function () {
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
    timers?.restore()
    timers = undefined
    restoreRects?.()
    restoreRects = undefined
    document.body.innerHTML = ''
  })

  it('opens Add to Roster with the short name and hands greyed, and jersey and positions blank', async () => {
    const { fake } = await open()
    await chooseBetts(fake)
    expect(text()).includes('Add to Roster')
    // The search field beneath would show through the sheet over it.
    expect(node('Search players')).equals(null)
    const first = node('First Name') as HTMLInputElement
    const last = node('Last Name') as HTMLInputElement
    const jersey = node('Jersey Number') as HTMLInputElement
    expect([first.value, last.value]).deep.equals(['Mookie', 'B'])
    expect(first.readOnly && last.readOnly).equals(true)
    expect(jersey.readOnly).equals(false)
    expect(jersey.value).equals('')
    expect(node('Throws right')).not.equals(null)
    expect(node('Bats right')).not.equals(null)
    // No pill to change the hands, and none of Create Player's actions.
    expect(node('Throws L')).equals(null)
    expect(node('Save and Create Another Player')).equals(null)
    expect(node('Create Placeholder Player')).equals(null)
    expect(
      [...document.querySelectorAll('[aria-selected="true"]')].filter(one =>
        (one.getAttribute('aria-label') ?? '').startsWith('Player position')
      )
    ).has.length(0)
    // Cancel returns to the search.
    const cancels = document.querySelectorAll<HTMLElement>(
      '[aria-label="Cancel"]'
    )
    await act(async () => {
      cancels[cancels.length - 1].click()
    })
    expect(node('First Name')).equals(null)
    expect(node('Choose Mookie B')).not.equals(null)
    expect(node('Search players')).not.equals(null)
  })

  it('adds him to the roster with the jersey and positions only, says who was told, and saves him', async () => {
    const { fake, sent } = await open()
    await chooseBetts(fake)
    await input('Jersey Number', '50')
    await click('Player position SS')
    await click('Player position EH')
    await click('Add to Roster')
    // EH is the game's alone: the team stores the rest.
    expect(sent.roster).deep.equals([
      {
        teamId: 'away',
        body: { userId: 'usr_betts', jersey: '50', positions: ['SS'] }
      }
    ])
    // Both sheets close; he is on the Roster tab with his badge.
    expect(node('Add to Roster')).equals(null)
    expect(node('Choose Mookie B')).equals(null)
    const row = [...document.querySelectorAll('[aria-label]')].find(one =>
      (one.getAttribute('aria-label') ?? '').startsWith('Mookie B, jersey 50')
    )
    expect(row, 'his roster row').not.equals(undefined)
    expect(row!.getAttribute('aria-label')).not.includes('game-only')
    expect(text()).includes(
      'Mookie B was added. Their guardians were notified.'
    )
    await click('Save Rosters')
    const saved = sent.saved.at(-1)!
    expect(saved.liveData.boxscore.teams.away.players).includes(9001)
    expect(saved.gameData.players[9001]).to.include({
      fullName: 'Mookie B',
      jersey: '50',
      local: false
    })
  })

  it('opens on the jersey, the first field that takes text', async () => {
    const { fake } = await open()
    await chooseBetts(fake)
    expect(document.activeElement).equals(node('Jersey Number'))
  })

  it('says when the player was on the roster already', async () => {
    const { fake } = await open({
      roster: async () => ({
        entry: entryOf(9001),
        noticeId: null,
        unchanged: true
      })
    })
    await chooseBetts(fake)
    await click('Add to Roster')
    expect(text()).includes('Mookie B is already on the roster.')
    expect(text()).not.includes('was added')
  })

  it('keeps a change made to the draft while the add was on its way', async () => {
    let answer: (value: ExistingPlayerAnswer) => void = () => undefined
    const { fake, sent } = await open({
      roster: async () =>
        await new Promise<ExistingPlayerAnswer>(resolve => {
          answer = resolve
        })
    })
    await chooseBetts(fake)
    await click('Add to Roster')
    // Meanwhile a batter leaves the lineup.
    await click('Lineup')
    const remove = document.querySelector<HTMLElement>(
      '[aria-label^="Remove "]'
    )!
    const removed = remove.getAttribute('aria-label')!
    await act(async () => {
      remove.click()
    })
    await act(async () => {
      answer({ entry: entryOf(9001), noticeId: null })
    })
    await click('Save Rosters')
    const saved = sent.saved.at(-1)!
    expect(saved.liveData.boxscore.teams.away.players).includes(9001)
    expect(
      document.querySelector(`[aria-label="${removed}"]`),
      'the removed batter stays removed'
    ).equals(null)
  })

  it('adds him as a pool player for this game, and says nothing of a notice nobody was sent', async () => {
    const { fake, sent } = await open()
    await chooseBetts(fake)
    await click('Add as Pool Player')
    expect(sent.guest).deep.equals([
      {
        side: 'away',
        body: { userId: 'usr_betts', jersey: null, positions: [] }
      }
    ])
    expect(text()).includes('Game-only player')
    expect(text()).includes('Mookie B was added.')
    expect(text()).not.includes('notified')
  })

  it('offers only Add as Pool Player, filled, on a side the caller does not manage', async () => {
    const { fake, sent } = await open({ rights: { away: false, home: true } })
    await chooseBetts(fake)
    expect(node('Add to Roster')).equals(null)
    const pool = node('Add as Pool Player')!
    // The filled button, not the green text action.
    expect(pool.textContent).equals('Add as Pool Player')
    await click('Add as Pool Player')
    expect(sent.roster).has.length(0)
    expect(sent.guest).has.length(1)
  })

  it('keeps the sheet over a pending add, explains it, and offers a placeholder instead', async () => {
    const { fake, sent } = await open({
      roster: async () => ({ pendingRequestId: 'req_2' })
    })
    await chooseBetts(fake)
    await click('Add to Roster')
    expect(text()).includes(
      "This needs approval first. Use a placeholder for this game."
    )
    expect(node('First Name')).not.equals(null)
    expect(node('Add to Roster')!.getAttribute('aria-disabled')).equals('true')
    // Nothing joined the draft.
    await click('Save Rosters')
    expect(
      sent.saved.at(-1)?.liveData.boxscore.teams.away.players ?? []
    ).not.includes(9001)
    await click('Create Placeholder')
    expect(text()).includes('Select number of players to create.')
  })

  it("keeps the sheet open with the server's message for a refusal", async () => {
    const { fake } = await open({
      roster: async () => {
        throw new HttpError('conflict', 'Mookie B is already on this team.')
      }
    })
    await chooseBetts(fake)
    await click('Add to Roster')
    expect(text()).includes('Mookie B is already on this team.')
    expect(node('First Name')).not.equals(null)
    // Anything else is the general line.
    await act(async () => {
      root!.unmount()
    })
    document.body.innerHTML = ''
    timers?.restore()
    const again = await open({
      guest: async () => {
        throw new Error('socket hang up')
      }
    })
    await chooseBetts(again.fake)
    await click('Add as Pool Player')
    expect(text()).includes('Unable to add the player. Please try again.')
  })

  it('checks the jersey before sending, and leaves the row off with no way to search', async () => {
    const { fake, sent } = await open()
    await chooseBetts(fake)
    await input('Jersey Number', '5a')
    await click('Add to Roster')
    expect(text()).includes('Use digits for the jersey number.')
    expect(sent.roster).has.length(0)
    await act(async () => {
      root!.unmount()
    })
    document.body.innerHTML = ''
    timers?.restore()
    await open({ withClient: false })
    expect(node('Add Existing Player')!.getAttribute('aria-disabled')).equals(
      'true'
    )
  })
})
