import { expect } from 'chai'
import { afterEach, before, describe, it } from 'mocha'
import React, { act } from 'react'

import { type RosterEntry, TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import type { StoredGame } from '../../common/scoring/session'
import { mount, press, settle, text, unmount } from '../../test/gameFormDom'
import {
  finalGame,
  importedThenScoredGame,
  inProgressGame,
  REPLAY_TEAMS
} from '../../test/replayGameFixture'
import { PlaysTab, summaryText } from './PlaysTab'

const game = {
  id: 'gam_plays',
  status: 'final',
  nonMemberView: false,
  awayTeamId: REPLAY_TEAMS.away.id,
  homeTeamId: REPLAY_TEAMS.home.id,
  awayTeamName: REPLAY_TEAMS.away.name,
  homeTeamName: REPLAY_TEAMS.home.name
}

/** The fields of a roster line the tab reads; the rest it never looks at. */
function rosterEntry(gumboId: number, avatarUrl: string | null): RosterEntry {
  return {
    userId: `usr_${gumboId}`,
    gumboId,
    shortName: `Player ${gumboId}`,
    avatarUrl
  } as unknown as RosterEntry
}

function clientFor(
  stored: () => Promise<StoredGame>,
  rosters: Record<string, () => Promise<RosterEntry[]>> = {}
): { client: TeamStationClient; reads: string[] } {
  const client = new TeamStationClient({ baseUrl: '/api/v1' })
  const reads: string[] = []
  client.gameEvents = async gameId => {
    reads.push(gameId)
    return await stored()
  }
  client.roster = async teamId => await (rosters[teamId] ?? (async () => []))()
  return { client, reads }
}

function line(atBatIndex: number): HTMLElement {
  const found = document.querySelector<HTMLElement>(
    `[data-testid="plays-line-${atBatIndex}"]`
  )
  if (found == null) throw new Error(`no line ${atBatIndex}`)
  return found
}

function lineButton(atBatIndex: number): HTMLElement | null {
  return line(atBatIndex).querySelector<HTMLElement>('[role="button"]')
}

async function tap(atBatIndex: number): Promise<void> {
  const button = lineButton(atBatIndex)
  expect(button, `line ${atBatIndex}`).not.equals(null)
  await act(async () => {
    button!.click()
  })
}

function pitchesOf(atBatIndex: number): HTMLElement[] {
  return [
    ...line(atBatIndex).querySelectorAll<HTMLElement>(
      '[data-testid="plays-pitch"]'
    )
  ]
}

/** The stored plays, read loosely as the tests poke into them. */
type Loose = Record<string, any>
function playsOf(game: StoredGame): Loose[] {
  return game.plays
}

function testIds(prefix: string): string[] {
  return [...document.querySelectorAll('[data-testid]')]
    .map(node => node.getAttribute('data-testid')!)
    .filter(id => id.startsWith(prefix))
}

describe('the Plays tab stream', function () {
  this.timeout(20000)
  let final: StoredGame
  let mixed: StoredGame
  let live: StoredGame
  before(async () => {
    final = await finalGame()
    mixed = await importedThenScoredGame()
    live = await inProgressGame()
  })
  afterEach(unmount)

  it('renders the halves in order, each line oldest first, and a summary closing each half', async () => {
    const { client, reads } = clientFor(async () => final)
    await mount(
      <PlaysTab
        client={client}
        game={game}
        signedIn
        onSignIn={() => undefined}
      />
    )
    expect(reads).deep.equals(['gam_plays'])
    const halves = testIds('plays-half-')
    expect(halves[0]).equals('plays-half-top-1')
    expect(halves[1]).equals('plays-half-bottom-1')
    expect(text()).includes('Top 1st')
    expect(text()).includes(REPLAY_TEAMS.away.name)
    // Every half of a final game has ended, so every one has a summary.
    expect(testIds('plays-summary-')).length(halves.length)
    expect(text()).includes('Runs: ')
    expect(text()).includes('Left on base: ')
    const indexes = testIds('plays-line-').map(id => Number(id.slice(11)))
    expect(indexes).deep.equals([...indexes].sort((a, b) => a - b))
    // A line: the outs and the pitcher; a scoring play its marker and score.
    expect(text()).match(/\d outs?/)
    expect(text()).includes('Pitcher: ')
    const scoring = document.querySelectorAll('[data-testid="plays-scoring"]')
    expect(scoring.length).greaterThan(0)
    expect(scoring[0].textContent).match(
      new RegExp(
        `${REPLAY_TEAMS.away.name} \\d+, ${REPLAY_TEAMS.home.name} \\d+`
      )
    )
    expect(scoring[0].querySelector('[aria-label="Scoring play"]')).not.equals(
      null
    )
  })

  it('opens a line into its pitches and closes it again', async () => {
    const { client } = clientFor(async () => final)
    await mount(
      <PlaysTab
        client={client}
        game={game}
        signedIn
        onSignIn={() => undefined}
      />
    )
    const first = playsOf(final).find(play => play.playEvents.length > 1)!
    const index = first.about.atBatIndex
    expect(pitchesOf(index)).length(0)
    expect(lineButton(index)!.getAttribute('aria-expanded')).equals('false')
    await tap(index)
    const pitches = pitchesOf(index)
    expect(pitches.length).greaterThan(0)
    expect(pitches[0].textContent).match(/^1/)
    expect(pitches[0].textContent).match(/\d-\d/)
    expect(lineButton(index)!.getAttribute('aria-expanded')).equals('true')
    await tap(index)
    expect(pitchesOf(index)).length(0)
  })

  it('shows speed, pitch type and the exit velocity of the in-play pitch', async () => {
    const clocked = structuredClone(final)
    const play = playsOf(clocked).find(one =>
      (one.playEvents as Loose[]).some(
        (event: Loose) => event.details?.isInPlay === true
      )
    )!
    for (const event of play.playEvents as Array<Record<string, any>>) {
      if (event.isPitch !== true) continue
      event.pitchData = { ...(event.pitchData ?? {}), startSpeed: 71.6 }
      event.details = {
        ...event.details,
        type: { code: 'FF', description: 'Four-Seam Fastball' }
      }
      if (event.details.isInPlay === true)
        event.hitData = { ...(event.hitData ?? {}), launchSpeed: 92.2 }
    }
    const { client } = clientFor(async () => clocked)
    await mount(
      <PlaysTab
        client={client}
        game={game}
        signedIn
        onSignIn={() => undefined}
      />
    )
    await tap(play.about.atBatIndex)
    const rows = pitchesOf(play.about.atBatIndex)
    expect(rows[0].textContent).includes('72 mph')
    expect(rows[0].textContent).includes('Four-Seam Fastball')
    expect(rows.at(-1)!.textContent).includes('Exit velocity 92 mph')
    expect(rows[0].textContent).not.includes('Exit velocity')
  })

  it('does not open a line with no pitches', async () => {
    const { client } = clientFor(async () => mixed)
    await mount(
      <PlaysTab
        client={client}
        game={game}
        signedIn
        onSignIn={() => undefined}
      />
    )
    const imported = playsOf(mixed).find(
      play => play.about.inning === 1 && (play.playEvents ?? []).length === 0
    )!
    expect(imported, 'an imported play').not.equals(undefined)
    expect(lineButton(imported.about.atBatIndex)).equals(null)
    expect(line(imported.about.atBatIndex).textContent).match(/\d outs?/)
    const scored = playsOf(mixed).find(
      play => play.about.inning === 3 && (play.playEvents ?? []).length > 0
    )!
    await tap(scored.about.atBatIndex)
    expect(pitchesOf(scored.about.atBatIndex).length).greaterThan(0)
  })

  it('shows the at-bat in progress as the last line, and no summary for the half still being played', async () => {
    const { client } = clientFor(async () => live)
    await mount(
      <PlaysTab
        client={client}
        game={{ ...game, status: 'inProgress' }}
        signedIn
        onSignIn={() => undefined}
      />
    )
    const ids = testIds('plays-line-')
    expect(ids.at(-1)).equals(
      `plays-line-${live.currentPlay!.about.atBatIndex}`
    )
    expect(text()).match(/Max Muncy batting, \d-\d, /)
    const halves = testIds('plays-half-')
    expect(testIds('plays-summary-')).length(halves.length - 1)
    expect(testIds('plays-summary-')).not.includes(
      `plays-summary-${halves.at(-1)!.slice(11)}`
    )
  })

  it('draws batters from the rosters, and initials where there is no picture or the roster is refused', async () => {
    const batter = playsOf(final)[0].matchup.batter.id
    const { client } = clientFor(async () => final, {
      [REPLAY_TEAMS.away.id]: async () => [
        rosterEntry(batter, 'https://pictures.example.test/soto.jpg'),
        rosterEntry(9102, null)
      ],
      [REPLAY_TEAMS.home.id]: async () => {
        throw new HttpError('forbidden', 'Members only')
      }
    })
    await mount(
      <PlaysTab
        client={client}
        game={game}
        signedIn
        onSignIn={() => undefined}
      />
    )
    await settle(50)
    expect(line(playsOf(final)[0].about.atBatIndex).innerHTML).includes(
      'https://pictures.example.test/soto.jpg'
    )
    const judge = playsOf(final).find(play => play.matchup.batter.id === 9102)!
    expect(line(judge.about.atBatIndex).textContent).includes('AJ')
    const home = playsOf(final).find(
      play => play.about.halfInning === 'bottom'
    )!
    expect(line(home.about.atBatIndex).innerHTML).not.includes('https://')
    expect(line(home.about.atBatIndex).textContent).match(/^[A-Z]{2}/)
  })

  it('shows a spinner while the plays are read, and Try again after a failed read', async () => {
    let fail = true
    let release: (() => void) | undefined
    const { client, reads } = clientFor(async () => {
      if (fail) throw new Error('offline')
      await new Promise<void>(resolve => {
        release = resolve
      })
      return final
    })
    await mount(
      <PlaysTab
        client={client}
        game={game}
        signedIn
        onSignIn={() => undefined}
      />
    )
    expect(text()).includes('Plays could not be loaded.')
    fail = false
    await press('Try again')
    expect(reads).length(2)
    expect(document.querySelector('[data-testid="plays-loading"]')).not.equals(
      null
    )
    await act(async () => {
      release!()
    })
    await settle(0)
    expect(document.querySelector('[data-testid="plays-stream"]')).not.equals(
      null
    )
  })

  it('asks a non-member and a guest to become members, and reads nothing', async () => {
    const { client, reads } = clientFor(async () => final)
    let rosterReads = 0
    client.roster = async () => {
      rosterReads++
      return []
    }
    await mount(
      <PlaysTab
        client={client}
        game={{ ...game, nonMemberView: true }}
        signedIn
        onSignIn={() => undefined}
      />
    )
    expect(text()).includes(
      "You need to be a member of one of these teams to see this game's Plays."
    )
    expect(text()).includes('Request membership')
    await unmount()
    let signIns = 0
    await mount(
      <PlaysTab
        client={client}
        game={{ ...game, nonMemberView: true }}
        signedIn={false}
        onSignIn={() => {
          signIns++
        }}
      />
    )
    expect(text()).includes(
      'Log in or create an account first to request membership.'
    )
    await press('Log in / Sign up')
    expect(signIns).equals(1)
    await unmount()
    await mount(
      <PlaysTab
        client={client}
        game={game}
        signedIn={null}
        onSignIn={() => undefined}
      />
    )
    expect(document.querySelector('[aria-label="Loading session"]')).not.equals(
      null
    )
    expect(reads).deep.equals([])
    expect(rosterReads).equals(0)
  })

  it('says each figure of a half it knows, and leaves the rest out', function () {
    expect(summaryText({ runs: 1, hits: 2, errors: 0, leftOnBase: 1 })).equals(
      'Runs: 1, Hits: 2, Errors: 0, Left on base: 1'
    )
    expect(summaryText({ runs: 0, leftOnBase: 2 })).equals(
      'Runs: 0, Left on base: 2'
    )
    expect(summaryText({})).equals('')
  })
})
