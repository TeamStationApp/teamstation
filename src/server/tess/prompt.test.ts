import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { contextText, instructions, sitemapText, systemBlocks } from './prompt'
import type { UserContext } from './userContext'

const user: UserContext = {
  userId: 'usr_demo',
  name: 'Mookie B.',
  siteAdmin: false,
  teams: [
    {
      teamId: 'tem_hawks',
      name: 'Demo Hawks',
      shortName: 'Hawks',
      roles: ['coach']
    }
  ],
  seasonsAdministered: [],
  leaguesAdministered: [],
  umpireLeagues: [],
  guardianOf: []
}
const now = new Date('2026-05-02T15:00:00Z')

describe("Tess's system prompt", function () {
  it('caches the instructions and the sitemap, and not the request’s own context', function () {
    const blocks = systemBlocks({ user, now })
    expect(blocks.map(block => block.cached === true)).deep.equals([
      true,
      true,
      false
    ])
    expect(blocks[0].text).equals(instructions())
    expect(blocks[1].text).equals(sitemapText())
    expect(blocks[2].text).equals(contextText({ user, now }))
  })

  it('says what Tess may do: decline before any tool, confirm every change, no live scoring, path links', function () {
    const text = instructions()
    expect(text).includes('never call a tool')
    expect(text).includes('confirmChange')
    expect(text).includes('Never say a change has happened')
    expect(text).includes('Live scoring')
    expect(text).includes('"path"')
    expect(text).includes('<svg>')
    expect(text).includes('<table>')
  })

  it('indexes the API she may use, with bodies for writes, and leaves the refused routes out', function () {
    const index = instructions().split('## API index')[1]
    expect(index).match(
      /^POST \/teams\/\{teamId\}\/games: Schedule a team's games\. Body: \{games\*: \{.*startAt\*: date-time/m
    )
    expect(index).match(/^GET \/teams\/\{teamId\}\/stats: .*\. Query: kind/m)
    expect(index).match(/^GET \/games\/\{gameId\}\/events/m)
    for (const refused of [
      /^POST \/games\/\{gameId\}\/events/m,
      /^POST \/games\/\{gameId\}\/lineups/m,
      /^\w+ \/me\/account/m,
      /^\w+ \/me\/tess/m,
      /^\w+ \/auth\//m,
      /^POST \/director\//m
    ])
      expect(index).not.match(refused)
    expect(index.split('\n').every(line => line.length <= 900)).equals(true)
  })

  it('carries the generated sitemap as it is checked in', function () {
    const file = JSON.parse(
      readFileSync(join(__dirname, 'sitemap.generated.json'), 'utf8')
    ) as unknown
    const text = sitemapText()
    expect(JSON.parse(text.replace(/^## App sitemap\n/, ''))).deep.equals(file)
  })

  it('names the person and the time, and the screen only when one was sent', function () {
    const narrow = contextText({ user, now })
    expect(narrow).includes('2026-05-02T15:00:00.000Z')
    expect(narrow).includes('"name":"Mookie B."')
    expect(narrow).not.includes('Their screen')
    const screen = {
      path: '/teams/tem_hawks?tab=schedule',
      title: 'Demo Hawks',
      stack: [{ path: '/', title: 'Home' }]
    }
    const wide = contextText({ user, now, screen })
    expect(wide).includes('## Their screen')
    expect(wide).includes(JSON.stringify(screen))
  })
})
