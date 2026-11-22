import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { useState } from 'react'

import type { UmpireSortKey } from '../../common/umpireSort'
import {
  byLabel,
  byTestId,
  click,
  render,
  settle,
  unmount
} from '../../test/tessTestKit'
import {
  chooseUmpireSort,
  removeUmpireSort,
  umpireSortChoices,
  UmpireSortControls,
  umpireSortWheelLabel
} from './UmpireSortControls'

/** The controls over a sort they hold, with every change kept. */
async function controls(
  start: UmpireSortKey[],
  os: 'web' | 'ios'
): Promise<{ sort: () => UmpireSortKey[]; changes: UmpireSortKey[][] }> {
  const changes: UmpireSortKey[][] = []
  let current = start
  function Harness(): React.ReactElement {
    const [sort, setSort] = useState(start)
    current = sort
    return (
      <UmpireSortControls
        sort={sort}
        os={os}
        onChange={next => {
          changes.push(next)
          setSort(next)
        }}
      />
    )
  }
  await render(<Harness />)
  return { sort: () => current, changes }
}

/** The sort buttons on show, by test id, in order. */
const buttons = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[data-testid^="umpire-sort-"]')]
    .map(node => node.dataset.testid!)
    .filter(id => /^umpire-sort-(1|2|add)$/.test(id))

const DATE_ASC = 'Sort by Date, oldest to newest'

describe('umpire sort controls', () => {
  afterEach(async () => {
    await unmount()
    document.body.replaceChildren()
  })

  it('chooses, adds and removes keys, and offers each slot only the other slot’s missing field', () => {
    expect(chooseUmpireSort([], 0, 'date')).deep.equals(['date'])
    expect(chooseUmpireSort(['date', 'season'], 0, '-date')).deep.equals([
      '-date',
      'season'
    ])
    expect(chooseUmpireSort(['date'], 1, 'certification')).deep.equals([
      'date',
      'certification'
    ])
    expect(chooseUmpireSort(['date', 'season'], 1, '-season')).deep.equals([
      'date',
      '-season'
    ])
    expect(removeUmpireSort(['date', 'season'], 0)).deep.equals(['season'])
    expect(removeUmpireSort(['date', 'season'], 1)).deep.equals(['date'])
    expect(removeUmpireSort(['date'], 0)).deep.equals([])
    expect(umpireSortChoices()).length(8)
    expect(umpireSortChoices('season')).deep.equals([
      'date',
      '-date',
      'certification',
      '-certification'
    ])
    expect(umpireSortChoices('-seasonPriority')).not.includes('season')
    expect(umpireSortChoices('date')).not.includes('-date')
    expect(umpireSortWheelLabel('certification')).equals(
      'Certification · A to Z'
    )
    expect(umpireSortWheelLabel('-date')).equals('Date · newest to oldest')
    expect(umpireSortWheelLabel('seasonPriority')).equals(
      'Season · league order'
    )
    expect(umpireSortWheelLabel('-seasonPriority')).equals(
      'Season · league reversed'
    )
    expect(umpireSortWheelLabel('-season')).equals('Season · Z to A')
  })

  for (const os of ['web', 'ios'] as const)
    describe(os, () => {
      it('shows Sort alone with no sort, one sort and + Sort, or both and no + Sort', async () => {
        await controls([], os)
        expect(buttons()).deep.equals(['umpire-sort-1'])
        expect(byTestId('umpire-sort-1')!.getAttribute('aria-label')).equals(
          'Sort'
        )
        expect(byTestId('umpire-sort-1')!.textContent).contains('Sort')
        await unmount()
        document.body.replaceChildren()
        await controls(['date'], os)
        expect(buttons()).deep.equals(['umpire-sort-1', 'umpire-sort-add'])
        expect(byTestId('umpire-sort-1')!.getAttribute('aria-label')).equals(
          DATE_ASC
        )
        expect(byTestId('umpire-sort-1')!.textContent).contains('Date')
        expect(byTestId('umpire-sort-add')!.getAttribute('aria-label')).equals(
          'Add a second sort'
        )
        await unmount()
        document.body.replaceChildren()
        await controls(['-certification', 'seasonPriority'], os)
        expect(buttons()).deep.equals(['umpire-sort-1', 'umpire-sort-2'])
        expect(byTestId('umpire-sort-1')!.getAttribute('aria-label')).equals(
          'Sort by Certification, Z to A'
        )
        expect(byTestId('umpire-sort-2')!.getAttribute('aria-label')).equals(
          'Then by Season, league order, first to last'
        )
        // Each button draws its icon before its label.
        const face = byTestId('umpire-sort-1')!
        const icon = face.querySelector('[data-testid="sort-icon"]')!
        expect(icon.textContent).equals('ZA')
        expect(
          byTestId('umpire-sort-2')!.querySelector('[data-testid="sort-icon"]')!
            .textContent
        ).equals('19')
      })
    })

  describe('web dropdown', () => {
    /** The rows of the open menu, by label, and which is marked. */
    const rows = (): Array<{ label: string; selected: string | null }> =>
      [
        ...byTestId('header-menu-panel')!.querySelectorAll<HTMLElement>(
          '[role="button"], [role="radio"]'
        )
      ].map(row => ({
        label: row.getAttribute('aria-label')!,
        selected: row.getAttribute('aria-checked')
      }))
    async function open(id: string): Promise<void> {
      await click(byTestId(id)!)
      await settle()
    }

    it('lists the second slot’s options without the first’s field, marks the chosen one, and ends with Remove sort', async () => {
      await controls(['date', 'season'], 'web')
      await open('umpire-sort-2')
      expect(rows()).deep.equals([
        { label: 'Season, A to Z', selected: 'true' },
        { label: 'Season, Z to A', selected: 'false' },
        { label: 'Season, league order, first to last', selected: 'false' },
        { label: 'Season, league order, last to first', selected: 'false' },
        { label: 'Certification, A to Z', selected: 'false' },
        { label: 'Certification, Z to A', selected: 'false' },
        { label: 'Remove sort', selected: null }
      ])
      const panel = byTestId('header-menu-panel')!
      // An icon on every option, and a radio mark on the chosen one only.
      expect(panel.querySelectorAll('[data-testid="sort-icon"]')).length(6)
      const remove = byLabel('Remove sort')
      const removeText = [...remove.querySelectorAll('[dir="auto"]')].find(
        node => node.textContent === 'Remove sort'
      )!
      expect(getComputedStyle(removeText).color).not.equals(
        getComputedStyle(
          [...byLabel('Season, A to Z').querySelectorAll('[dir="auto"]')].find(
            node => node.textContent === 'Season, A to Z'
          )!
        ).color
      )
    })

    it('lists every option for the first slot while the second is empty, and chooses in each slot', async () => {
      const h = await controls(['date'], 'web')
      await open('umpire-sort-1')
      expect(rows().map(row => row.label)).length(9)
      expect(rows()[0]).deep.equals({
        label: 'Date, oldest to newest',
        selected: 'true'
      })
      await click(byLabel('Season, league order, first to last'))
      await settle()
      expect(h.sort()).deep.equals(['seasonPriority'])
      // The + Sort picker offers no Season, and has nothing to remove.
      await open('umpire-sort-add')
      expect(rows().map(row => row.label)).deep.equals([
        'Date, oldest to newest',
        'Date, newest to oldest',
        'Certification, A to Z',
        'Certification, Z to A'
      ])
      expect(rows().every(row => row.selected === 'false')).equals(true)
      await click(byLabel('Certification, Z to A'))
      await settle()
      expect(h.sort()).deep.equals(['seasonPriority', '-certification'])
      // The chosen option again changes nothing.
      await open('umpire-sort-2')
      await click(byLabel('Certification, Z to A'))
      await settle()
      expect(h.changes).length(2)
    })

    it('promotes the second sort when the first is removed, and brings back + Sort when the second is', async () => {
      const h = await controls(['seasonPriority', '-certification'], 'web')
      await open('umpire-sort-1')
      await click(byLabel('Remove sort'))
      await settle()
      expect(h.sort()).deep.equals(['-certification'])
      expect(buttons()).deep.equals(['umpire-sort-1', 'umpire-sort-add'])
      await open('umpire-sort-add')
      await click(byLabel('Season, league order, first to last'))
      await settle()
      expect(h.sort()).deep.equals(['-certification', 'seasonPriority'])
      await open('umpire-sort-2')
      await click(byLabel('Remove sort'))
      await settle()
      expect(h.sort()).deep.equals(['-certification'])
      expect(buttons()).deep.equals(['umpire-sort-1', 'umpire-sort-add'])
      // Removing the only sort leaves Sort alone.
      await open('umpire-sort-1')
      await click(byLabel('Remove sort'))
      await settle()
      expect(h.sort()).deep.equals([])
      expect(buttons()).deep.equals(['umpire-sort-1'])
    })
  })

  describe('app sheet', () => {
    const sheet = (): HTMLElement | null => byTestId('umpire-sort-sheet')
    /** The wheel's rows, as they read. */
    const wheelRows = (): string[] =>
      [
        ...sheet()!.querySelectorAll<HTMLElement>(
          '[data-testid^="umpire-sort-wheel-"]'
        )
      ].map(row => row.textContent!)

    it('slides up titled Then by with a wheel of the second slot’s options, Done, Remove sort and Cancel', async () => {
      const h = await controls(['date', 'season'], 'ios')
      expect(sheet()).equals(null)
      await click(byTestId('umpire-sort-2')!)
      expect(sheet()).not.equals(null)
      expect(sheet()!.textContent).contains('Then by')
      expect(wheelRows()).deep.equals([
        'Season · A to Z',
        'Season · Z to A',
        'Season · league order',
        'Season · league reversed',
        'Certification · A to Z',
        'Certification · Z to A'
      ])
      expect(
        byTestId('umpire-sort-wheel-0')!.getAttribute('aria-selected') ??
          byTestId('umpire-sort-wheel-0')!.getAttribute('aria-checked')
      ).not.equals('false')
      expect(byTestId('umpire-sort-done')).not.equals(null)
      expect(byTestId('umpire-sort-remove')).not.equals(null)
      expect(byTestId('umpire-sort-cancel')).not.equals(null)
      // Done is not destructive: Cancel is red, as Remove sort is, not blue.
      const textOf = (id: string): string => {
        const label = [...byTestId(id)!.querySelectorAll('[dir="auto"]')].find(
          node => node.textContent !== ''
        )!
        return getComputedStyle(label).color
      }
      expect(textOf('umpire-sort-cancel')).equals(textOf('umpire-sort-remove'))
      // Done applies the wheel's row.
      await click(byTestId('umpire-sort-wheel-4')!)
      await click(byTestId('umpire-sort-done')!)
      expect(sheet()).equals(null)
      expect(h.sort()).deep.equals(['date', 'certification'])
      expect(byTestId('umpire-sort-2')!.textContent).contains('Certification')
    })

    it('shows its title once, and every row short enough for a 320 point phone, each direction told apart in words', async () => {
      /** How often `text` shows in the sheet. */
      const times = (text: string): number =>
        sheet()!.textContent!.split(text).length - 1
      await controls(['date'], 'ios')
      await click(byTestId('umpire-sort-add')!)
      expect(times('Then by')).equals(1)
      // The wheel still names itself to assistive technology.
      expect(sheet()!.querySelector('[aria-label^="Then by: "]')).not.equals(
        null
      )
      await click(byTestId('umpire-sort-cancel')!)
      await click(byTestId('umpire-sort-1')!)
      expect(times('Sort by')).equals(1)
      const rows = wheelRows()
      expect(rows).length(8)
      // About 24 characters fit the wheel's middle row at 320 points.
      for (const row of rows) expect(row.length, row).lessThanOrEqual(24)
      // The rows of one field differ in a word, not only in an arrow glyph.
      const words = (row: string): string =>
        row
          .replace(/[^A-Za-z ]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      expect(new Set(rows.map(words)).size).equals(rows.length)
      // The buttons keep the whole direction in their labels.
      expect(byTestId('umpire-sort-1')!.getAttribute('aria-label')).equals(
        DATE_ASC
      )
    })

    it('changes nothing on Cancel or on Done over the chosen row, and removes with Remove sort', async () => {
      const h = await controls(['date', 'season'], 'ios')
      await click(byTestId('umpire-sort-2')!)
      await click(byTestId('umpire-sort-wheel-3')!)
      await click(byTestId('umpire-sort-cancel')!)
      expect(sheet()).equals(null)
      expect(h.changes).length(0)
      await click(byTestId('umpire-sort-2')!)
      await click(byTestId('umpire-sort-done')!)
      expect(h.changes).length(0)
      await click(byTestId('umpire-sort-2')!)
      await click(byTestId('umpire-sort-remove')!)
      expect(sheet()).equals(null)
      expect(h.sort()).deep.equals(['date'])
      expect(buttons()).deep.equals(['umpire-sort-1', 'umpire-sort-add'])
    })

    it('titles the first slot Sort by, and adds a second sort with no Remove sort', async () => {
      const h = await controls(['date'], 'ios')
      await click(byTestId('umpire-sort-1')!)
      expect(sheet()!.textContent).contains('Sort by')
      expect(wheelRows()).length(8)
      await click(byTestId('umpire-sort-wheel-1')!)
      await click(byTestId('umpire-sort-done')!)
      expect(h.sort()).deep.equals(['-date'])
      await click(byTestId('umpire-sort-add')!)
      expect(sheet()!.textContent).contains('Then by')
      expect(byTestId('umpire-sort-remove')).equals(null)
      expect(wheelRows()).length(6)
      await click(byTestId('umpire-sort-done')!)
      expect(h.sort()).deep.equals(['-date', 'season'])
      // The backdrop closes it too, changing nothing.
      await click(byTestId('umpire-sort-1')!)
      await click(byLabel('Close menu'))
      expect(sheet()).equals(null)
      expect(h.sort()).deep.equals(['-date', 'season'])
    })
  })
})
