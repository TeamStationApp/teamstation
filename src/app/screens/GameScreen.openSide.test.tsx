import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import {
  asTeamSummary,
  TeamStationClient,
  type TeamSummary
} from '../../common/api'
import { NoticesProvider, ScreenNotices } from '../../test/screenNotices'
import { gameFixture } from '../scoring/isUnscoredGame.test'
import { ThemeProvider } from '../theme/ThemeContext'
import { GameScreen } from './GameScreen'

const notices = new ScreenNotices()
let root: Root | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.replaceChildren()
})

async function render(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      <ThemeProvider>
        <NoticesProvider notices={notices}>
          <GestureHandlerRootView>{element}</GestureHandlerRootView>
        </NoticesProvider>
      </ThemeProvider>
    )
    await delay(30)
  })
}

const hawks = asTeamSummary({
  id: 'home',
  name: 'Hawks',
  shortName: null,
  logoPath: null,
  logoUrl: null
})

/** The game page of a game whose away side is open, as a member reads it. */
function client(asked: string[]): TeamStationClient {
  const made = new TeamStationClient({ baseUrl: '/api/v1' })
  made.game = async () => ({
    ...gameFixture,
    awayTeamId: null,
    awayTeamName: 'TBD',
    canScore: false,
    assignedRoles: { away: [], home: [] }
  })
  made.teams = async () => [hawks]
  made.seasonTeams = async () => []
  made.eventInfo = async () => {
    throw new Error('not an event manager')
  }
  made.gameScheduling = async () => {
    throw new Error('not a scheduler')
  }
  made.highlights = async () => {
    throw new Error('none')
  }
  made.boxScore = async () => {
    throw new Error('none')
  }
  made.wallTimeline = async () => {
    throw new Error('none')
  }
  made.playback = async () => {
    throw new Error('none')
  }
  made.roster = async teamId => {
    asked.push(`roster ${teamId}`)
    return []
  }
  return made
}

describe('the game page of a game with an open side', function () {
  it('names the open side TBD with no team link, and keeps the named side’s', async function () {
    const asked: string[] = []
    const opened: TeamSummary[] = []
    await render(
      <GameScreen
        client={client(asked)}
        gameId="g1"
        signedIn
        onOpenTeam={team => opened.push(team)}
      />
    )
    const page = document.body
    expect(page.textContent).includes('TBD')
    expect(page.querySelector('[aria-label="TBD"]')).equals(null)
    const links = [
      ...page.querySelectorAll<HTMLElement>('[role="link"]')
    ].filter(node => (node.textContent ?? '').includes('TBD'))
    expect(links).deep.equals([])
    const home = page.querySelector<HTMLElement>('[aria-label="Hawks"]')
    expect(home).not.equals(null)
    await act(async () => {
      home!.click()
      await delay(10)
    })
    expect(opened.map(team => team.id)).deep.equals(['home'])
    expect(asked.filter(read => read.includes('null'))).deep.equals([])
  })
})
