import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { asSeasonSummary, type TeamStationClient } from '../../common/api'
import { ThemeProvider } from '../theme/ThemeContext'
import { SeasonPresentation } from './SeasonPresentation'

/** A season's page links to the season's chats its viewer is in. */
let root: Root | undefined

const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  document.body.innerHTML = ''
})

const season = asSeasonSummary({
  id: 'sea_spring',
  leagueId: null,
  name: 'Spring 2027',
  year: 2027,
  term: null,
  ageGroup: null,
  teams: 0,
  games: 0,
  videos: 0
})

/** Every read answers nothing; the season's group detail is refused. */
const client = new Proxy(
  {},
  {
    get: (_, name) =>
      name === 'group'
        ? async () => {
            throw new Error('offline')
          }
        : async () => []
  }
) as TeamStationClient

describe('entity chat season sections', function () {
  it('links to each one, and opens it', async function () {
    const opened: string[] = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <SeasonPresentation
            client={client}
            season={season}
            onOpenGame={() => undefined}
            onOpenTeam={() => undefined}
            chats={[{ id: 'cnv_org', title: 'Spring Org' }]}
            onOpenChat={chat => opened.push(chat.id)}
          />
        </ThemeProvider>
      )
      await delay(20)
    })
    expect(document.querySelector('[data-testid="entity-chats"]')).equals(null)
    await act(async () => {
      document
        .querySelector<HTMLElement>('[role="tab"][aria-label="Chats"]')!
        .click()
    })
    const link = document.querySelector<HTMLElement>(
      '[role="button"][aria-label="Open Spring Org"]'
    )
    expect(link, 'the chat’s link').not.equals(null)
    await act(async () => {
      link!.click()
      await delay(10)
    })
    expect(opened).deep.equals(['cnv_org'])
  })

  it('draws no links without a way to open them', async function () {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    await act(async () => {
      root!.render(
        <ThemeProvider>
          <SeasonPresentation
            client={client}
            season={season}
            onOpenGame={() => undefined}
            onOpenTeam={() => undefined}
            chats={[{ id: 'cnv_org', title: 'Spring Org' }]}
          />
        </ThemeProvider>
      )
      await delay(20)
    })
    expect(
      document.querySelector('[role="button"][aria-label="Open Spring Org"]')
    ).equals(null)
  })
})
