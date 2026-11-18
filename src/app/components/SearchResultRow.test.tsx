import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type {
  SearchGroupResult,
  SearchPersonResult
} from '../../common/search/types'
import { userIdOfGumbo } from '../../common/userId'
import { ThemeProvider } from '../theme/ThemeContext'
import {
  FOLLOW_HEIGHT_REM,
  FOLLOW_SLOP,
  kindLabel,
  nameLines,
  nameWords,
  resultLines,
  SearchResultRow
} from './SearchResultRow'

let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
})

async function mount(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(<ThemeProvider>{element}</ThemeProvider>)
  })
}

const control = (label: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('[role="button"]')].find(
    node => node.getAttribute('aria-label') === label
  )

const team: SearchGroupResult = {
  kind: 'team',
  id: 'tem_hawks',
  name: 'Demo Hawks',
  imageUrl: null,
  cityLine: 'Demo City, Demo Region',
  associations: 'Demo Spring · Demo League',
  follow: 'follow'
}
const league: SearchGroupResult = {
  kind: 'league',
  id: 'lea_demo',
  name: 'Demo League',
  imageUrl: null,
  cityLine: null,
  associations: 'Demo City, Demo Region',
  follow: null
}
const person: SearchPersonResult = {
  kind: 'person',
  userId: userIdOfGumbo(27),
  name: 'Mike Trout',
  avatarUrl: null,
  associations: 'Demo Hawks'
}

describe('a search result row', function () {
  it('names each kind and writes its city and associations beneath the name', function () {
    expect([team, league, person].map(kindLabel)).deep.equals([
      'Team',
      'League',
      'Person'
    ])
    expect(kindLabel({ ...league, kind: 'season' })).equals('Season')
    expect(resultLines(team)).deep.equals([
      'Demo City, Demo Region',
      'Demo Spring · Demo League'
    ])
    expect(resultLines(league)).deep.equals(['Demo City, Demo Region'])
    expect(
      resultLines({ ...team, cityLine: null, associations: '' })
    ).deep.equals([])
    expect(resultLines(person)).deep.equals(['Demo Hawks'])
  })

  it('opens the group and follows it through separate targets, with the kind pill before Follow', async function () {
    const pressed: string[] = []
    await mount(
      <SearchResultRow
        result={team}
        accessibilityLabel="Open Demo Hawks"
        onPress={() => pressed.push('open')}
        follow="follow"
        onToggleFollow={() => pressed.push('follow')}
      />
    )
    const row = document.querySelector('[data-testid="search-result-row"]')!
    const text = row.textContent ?? ''
    expect(text).includes('Demo Hawks')
    expect(text).includes('Demo City, Demo Region')
    expect(text).includes('Demo Spring · Demo League')
    expect(text.indexOf('Team')).lessThan(text.indexOf('Follow'))
    const open = control('Open Demo Hawks')!
    const follow = control('Follow Demo Hawks')!
    expect(open.contains(follow)).equals(false)
    await act(async () => {
      open.click()
    })
    await act(async () => {
      follow.click()
    })
    expect(pressed).deep.equals(['open', 'follow'])
  })

  it('draws Follow at the kind pill’s 20 points, with a 12-point label and a target 44 points tall', async function () {
    await mount(
      <SearchResultRow
        result={team}
        accessibilityLabel="Open Demo Hawks"
        onPress={() => undefined}
        follow="follow"
        onToggleFollow={() => undefined}
      />
    )
    const follow = control('Follow Demo Hawks')!
    // The kind pill: the box around its label, as tall as Follow.
    const kindHeights = [...document.querySelectorAll<HTMLElement>('div')]
      .filter(node => node.textContent === 'Team')
      .map(node => window.getComputedStyle(node).height)
    expect(window.getComputedStyle(follow).height).equals('20px')
    expect(kindHeights).includes('20px')
    expect(FOLLOW_HEIGHT_REM).equals(1.25)
    const label = [...follow.querySelectorAll<HTMLElement>('div')].find(
      node => node.textContent === 'Follow' && node.children.length === 0
    )!
    expect(window.getComputedStyle(label).fontSize).equals('12px')
    expect(20 + 2 * FOLLOW_SLOP).greaterThanOrEqual(44)
  })

  it('reads Following when followed, and draws no Follow pill for none or for a person', async function () {
    await mount(
      <SearchResultRow
        result={team}
        accessibilityLabel="Open Demo Hawks"
        onPress={() => {}}
        follow="following"
        followBusy
      />
    )
    const unfollow = control('Unfollow Demo Hawks')!
    expect(unfollow.textContent).not.includes('Follow ')
    await act(async () => {
      unfollow.click()
    })
    await act(async () => root?.unmount())
    document.body.replaceChildren()

    await mount(
      <SearchResultRow
        result={league}
        accessibilityLabel="Open Demo League"
        onPress={() => {}}
        follow={null}
      />
    )
    expect(control('Follow Demo League')).equals(undefined)
    expect(document.body.textContent).includes('League')
    await act(async () => root?.unmount())
    document.body.replaceChildren()

    let opened = 0
    await mount(
      <SearchResultRow
        result={person}
        accessibilityLabel="Open Mike Trout"
        onPress={() => opened++}
        follow="follow"
      />
    )
    expect(control('Follow Mike Trout')).equals(undefined)
    expect(document.body.textContent).includes('Person')
    await act(async () => {
      control('Open Mike Trout')!.click()
    })
    expect(opened).equals(1)
  })

  it('shares only the name line with the pills, and runs the lines beneath the full text width', async function () {
    const longName =
      'Demo Hawks of the Very Long Name That Has To Truncate Somewhere'
    const longAssociations = Array.from(
      { length: 6 },
      (_, index) => `Demo Spring 20${20 + index}`
    ).join(' · ')
    const cases = [
      {
        result: { ...team, name: longName, associations: longAssociations },
        follow: 'follow' as const,
        top: [longName, 'Team', 'Follow']
      },
      {
        result: team,
        follow: 'following' as const,
        top: ['Demo Hawks', 'Team', 'Following']
      },
      { result: league, follow: null, top: ['Demo League', 'League'] },
      { result: person, follow: undefined, top: ['Mike Trout', 'Person'] },
      {
        result: { ...league, associations: '' },
        follow: 'follow' as const,
        top: ['Demo League', 'League', 'Follow']
      }
    ]
    for (const { result, follow, top: expected } of cases) {
      await mount(
        <SearchResultRow
          result={result}
          accessibilityLabel={`Open ${result.name}`}
          onPress={() => {}}
          follow={follow}
        />
      )
      const row = document.querySelector('[data-testid="search-result-row"]')!
      const top = row.querySelector<HTMLElement>(
        '[data-testid="search-result-top"]'
      )!
      const pills = top.querySelector<HTMLElement>(
        '[data-testid="search-result-pills"]'
      )!
      expect(top.textContent).equals(expected.join(''))
      expect(pills.textContent).equals(expected.slice(1).join(''))
      // Before its words are measured, the name is two lines that
      // ellipsize, in the width the pills leave; the pills keep theirs.
      const name = [...top.querySelectorAll<HTMLElement>('div')].find(
        node => node.textContent === result.name && node.children.length === 0
      )!
      expect(name.getAttribute('style')).includes('-webkit-line-clamp: 2')
      expect(getComputedStyle(name).textOverflow).equals('ellipsis')
      expect(getComputedStyle(name.parentElement!).flexGrow).equals('1')
      expect(getComputedStyle(name.parentElement!).minWidth).equals('0px')
      expect(getComputedStyle(pills).flexShrink).equals('0')
      // The city and association lines are beneath the name's line, outside
      // the pills' container, and wrap rather than truncate.
      const lines = [
        ...row.querySelectorAll<HTMLElement>(
          '[data-testid="search-result-lines"] > *'
        )
      ]
      expect(lines.map(line => line.textContent)).deep.equals(
        resultLines(result)
      )
      if (lines.length > 0)
        expect(getComputedStyle(lines[0].parentElement!).pointerEvents).equals(
          'none'
        )
      for (const line of lines) {
        expect(top.contains(line)).equals(false)
        expect(line.parentElement!.parentElement).equals(top.parentElement)
        expect(getComputedStyle(line).whiteSpace).not.equals('nowrap')
      }
      // The open target covers the card beneath the content, and neither
      // holds the other's controls; what it draws is read through its label.
      const open = control(`Open ${result.name}`)!
      expect(getComputedStyle(open).position).equals('absolute')
      expect(open.contains(top)).equals(false)
      expect(name.closest('[aria-hidden="true"]')).not.equals(null)
      await act(async () => root?.unmount())
      root = undefined
      document.body.replaceChildren()
    }
  })

  it('breaks a name between words: what fits beside the pills, and the rest on the full-width line', function () {
    const name = 'Hawks Spring 2024 0ecc1009'
    // Each run of the first words, measured on one line.
    const runs = [50, 110, 150, 230]
    expect(nameWords('  Hawks  Spring ')).deep.equals(['Hawks', 'Spring'])
    expect(nameLines(name, runs, 120)).deep.equals([
      'Hawks Spring',
      '2024 0ecc1009'
    ])
    expect(nameLines(name, runs, 50)).deep.equals([
      'Hawks',
      'Spring 2024 0ecc1009'
    ])
    // It fits on the first line, not even a word fits, it is one word, or
    // it is not measured yet: one block in the first line's width.
    expect(nameLines(name, runs, 300)).equals(null)
    expect(nameLines(name, runs, 40)).equals(null)
    expect(nameLines('Hawks', [50], 40)).equals(null)
    expect(nameLines(name, runs, null)).equals(null)
    expect(nameLines(name, [50, undefined, 150, 230], 200)).equals(null)
  })

  it('draws the rest of a measured name on its own full-width line, and keeps what fits beside the pills', async function () {
    const season: SearchGroupResult = {
      ...team,
      kind: 'season',
      name: 'Hawks Spring 2024 0ecc1009',
      cityLine: 'Demo City, Demo Region'
    }
    await mount(
      <SearchResultRow
        result={season}
        accessibilityLabel="Open it"
        onPress={() => {}}
        follow="follow"
      />
    )
    type Laid = HTMLElement & {
      __reactLayoutHandler: (event: object) => void
    }
    const lay = async (node: Element, width: number): Promise<void> => {
      await act(async () => {
        ;(node as Laid).__reactLayoutHandler({
          nativeEvent: { layout: { x: 0, y: 0, width, height: 20 } }
        })
      })
    }
    const top = document.querySelector('[data-testid="search-result-top"]')!
    const name = document.querySelector('[data-testid="search-result-name"]')!
    const runs = [
      ...document.querySelector('[data-testid="search-result-name-runs"]')!
        .children
    ]
    expect(runs.map(run => run.textContent)).deep.equals([
      'Hawks',
      'Hawks Spring',
      'Hawks Spring 2024',
      'Hawks Spring 2024 0ecc1009'
    ])
    await lay(name, 120)
    for (const [at, width] of [50, 110, 150, 230].entries())
      await lay(runs[at], width)
    // Measured again the same, nothing changes.
    await lay(name, 120)
    await lay(runs[0], 50)
    expect(top.textContent).equals('Hawks SpringSeasonFollow')
    expect(
      document.querySelector('[data-testid="search-result-name-rest"]')!
        .textContent
    ).equals('2024 0ecc1009')
    // Wide enough for the whole name: one block again.
    await lay(name, 300)
    expect(top.textContent).equals(`${season.name}SeasonFollow`)
    expect(
      document.querySelector('[data-testid="search-result-name-rest"]')
    ).equals(null)
  })
})
