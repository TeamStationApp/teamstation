import { expect } from 'chai'
import { describe, it } from 'mocha'
import { base64url } from 'rfc4648'

import { HttpError } from '../../common/errors'
import {
  UMPIRE_SORT_KEYS,
  umpireRowOrder,
  type UmpireSortKey,
  type UmpireSortRow
} from '../../common/umpireSort'
import { encodeScheduleCursor } from '../schedule/scheduleCursor'
import {
  decodeUmpireCursor,
  encodeUmpireCursor,
  type UmpireCursor,
  umpireFirstPage,
  umpirePageAround,
  umpirePageOfHeld
} from './scheduleOrder'

const seasons = [
  { seasonId: 'sea_a', seasonName: 'Demo Alpha', seasonPriority: 2 },
  { seasonId: 'sea_b', seasonName: 'Demo Bravo', seasonPriority: null },
  { seasonId: 'sea_c', seasonName: 'Demo Charlie', seasonPriority: 1 }
]
const levels = ['majors', 'minors', 'AAA']
// Twelve rows over four days, three seasons, with tied starts.
const rows: UmpireSortRow[] = Array.from({ length: 12 }, (_, i) => {
  const startAt = new Date(
    Date.UTC(2027, 3, 3 + Math.floor(i / 3), 15 + (i % 2))
  ).toISOString()
  return {
    id: `gam_${String(i).padStart(2, '0')}`,
    start: Date.parse(startAt),
    day: startAt.slice(0, 10),
    ...seasons[i % 3],
    levelName: levels[(i + 1) % 3]
  }
})
const keys = (row: UmpireSortRow): UmpireSortRow => row
const inSort = (sort: UmpireSortKey[]): UmpireSortRow[] =>
  rows.toSorted(umpireRowOrder(sort))
const ids = (list: UmpireSortRow[]): string[] => list.map(row => row.id)

function refused(text: string): string {
  try {
    decodeUmpireCursor(text)
  } catch (error) {
    if (error instanceof HttpError) return `${error.status} ${error.message}`
    throw error
  }
  throw new Error('expected a 400')
}
const encoded = (value: unknown): string =>
  base64url.stringify(new TextEncoder().encode(JSON.stringify(value)), {
    pad: false
  })

describe('umpire schedule cursors', () => {
  it('round-trips a cursor with its sort and the boundary row', () => {
    for (const cursor of [
      { sort: ['-date', 'seasonPriority'], row: rows[4], direction: 'next' },
      { sort: [], row: rows[1], direction: 'prev' }
    ] as UmpireCursor[])
      expect(decodeUmpireCursor(encodeUmpireCursor(cursor))).deep.equals(cursor)
  })

  it('refuses a malformed, wrong-shaped or old cursor', () => {
    const good = JSON.parse(
      new TextDecoder().decode(
        base64url.parse(
          encodeUmpireCursor({
            sort: ['date'],
            row: rows[0],
            direction: 'next'
          }),
          { loose: true }
        )
      )
    )
    const row = good.row as unknown[]
    const swap = (at: number, value: unknown): unknown[] =>
      row.map((one, i) => (i === at ? value : one))
    for (const text of [
      'abc',
      encoded([1, 2]),
      encoded(null),
      encoded({ ...good, sort: 'bogus' }),
      encoded({ ...good, sort: 7 }),
      encoded({ ...good, direction: 'up' }),
      encoded({ ...good, row: row.slice(1) }),
      encoded({ ...good, row: swap(0, '3 April') }),
      encoded({ ...good, row: swap(1, 'soon') }),
      encoded({ ...good, row: swap(2, '') }),
      encoded({ ...good, row: swap(3, 4) }),
      encoded({ ...good, row: swap(4, null) }),
      encoded({ ...good, row: swap(5, 1.5) }),
      encoded({ ...good, row: swap(6, false) }),
      // The other schedules' cursor is not this list's.
      encodeScheduleCursor({
        startAt: new Date(rows[0].start).toISOString(),
        id: rows[0].id,
        direction: 'next',
        order: 'asc'
      })
    ])
      expect(refused(text), text).equals(
        '400 cursor is not a cursor this list gave'
      )
  })
})

describe('umpire schedule pages', () => {
  const walkForward = (sort: UmpireSortKey[], limit: number): string[][] => {
    const list = inSort(sort)
    const pages = [umpirePageOfHeld(list, limit, sort, keys)]
    while (pages.at(-1)!.nextCursor != null) {
      pages.push(
        umpirePageOfHeld(
          list,
          limit,
          sort,
          keys,
          decodeUmpireCursor(pages.at(-1)!.nextCursor!)
        )
      )
      expect(pages.length).lessThan(50)
    }
    return pages.map(page => ids(page.items))
  }

  it('walks forward and back under each sort, meeting each row once', () => {
    const sorts: UmpireSortKey[][] = [
      [],
      ...UMPIRE_SORT_KEYS.map(key => [key]),
      ['season', 'certification'],
      ['-date', 'seasonPriority']
    ]
    for (const sort of sorts)
      for (const limit of [1, 4, 5]) {
        const list = inSort(sort)
        const forward = walkForward(sort, limit)
        expect(forward.flat(), `${sort.join(',')} ${limit}`).deep.equals(
          ids(list)
        )
        // Back from the last page to the first.
        let page = umpirePageOfHeld(list, limit, sort, keys)
        while (page.nextCursor != null)
          page = umpirePageOfHeld(
            list,
            limit,
            sort,
            keys,
            decodeUmpireCursor(page.nextCursor)
          )
        const back = [ids(page.items)]
        while (page.prevCursor != null) {
          page = umpirePageOfHeld(
            list,
            limit,
            sort,
            keys,
            decodeUmpireCursor(page.prevCursor)
          )
          back.unshift(ids(page.items))
        }
        expect(back.flat(), `${sort.join(',')} ${limit} back`).deep.equals(
          ids(list)
        )
      }
  })

  it('places the next page when the boundary row is gone', () => {
    const sort: UmpireSortKey[] = ['seasonPriority', '-certification']
    const list = inSort(sort)
    const first = umpirePageOfHeld(list, 4, sort, keys)
    const boundary = first.items.at(-1)!
    const without = list.filter(row => row.id !== boundary.id)
    const next = umpirePageOfHeld(
      without,
      4,
      sort,
      keys,
      decodeUmpireCursor(first.nextCursor!)
    )
    expect(ids(next.items)).deep.equals(ids(list.slice(4, 8)))
    // Back from it, with the boundary row gone, the rows before it.
    const back = umpirePageOfHeld(
      without,
      4,
      sort,
      keys,
      decodeUmpireCursor(next.prevCursor!)
    )
    expect(ids(back.items)).deep.equals(ids(list.slice(0, 3)))
  })

  it('leaves an empty page from the place it was read from', () => {
    const sort: UmpireSortKey[] = ['date']
    const list = inSort(sort)
    const last = list.at(-1)!
    for (const direction of ['next', 'prev'] as const) {
      const cursor: UmpireCursor = {
        sort,
        row: direction === 'next' ? last : list[0],
        direction
      }
      const page = umpirePageOfHeld(list, 3, sort, keys, cursor)
      expect(page.items).deep.equals([])
      const back = decodeUmpireCursor(
        (direction === 'next' ? page.prevCursor : page.nextCursor)!
      )
      expect(back.row).deep.equals(cursor.row)
      expect(back.sort).deep.equals(sort)
    }
  })

  it('cuts a page around a row, with cursors that carry the sort', () => {
    const sort: UmpireSortKey[] = ['season', 'certification']
    const list = inSort(sort)
    const page = umpirePageAround(list, 5, 4, sort, keys)
    expect(ids(page.items)).deep.equals(ids(list.slice(3, 9)))
    const next = decodeUmpireCursor(page.nextCursor!)
    const prev = decodeUmpireCursor(page.prevCursor!)
    expect([next.sort, next.row.id, next.direction]).deep.equals([
      sort,
      list[8].id,
      'next'
    ])
    expect([prev.sort, prev.row.id, prev.direction]).deep.equals([
      sort,
      list[3].id,
      'prev'
    ])
    const ends = umpirePageAround(list, 0, 20, sort, keys)
    expect([ends.prevCursor, ends.nextCursor]).deep.equals([null, null])
    expect(umpirePageAround([], 0, 4, sort, keys)).deep.equals({
      items: [],
      nextCursor: null,
      prevCursor: null
    })
  })

  it('gives a first page with a cursor only when more rows follow', () => {
    const sort: UmpireSortKey[] = ['-seasonPriority']
    const list = inSort(sort)
    const first = umpireFirstPage(list, 5, sort, keys)
    expect(first.prevCursor).equals(null)
    expect(decodeUmpireCursor(first.nextCursor!).row).deep.equals(list[4])
    expect(umpireFirstPage(list, 12, sort, keys).nextCursor).equals(null)
  })
})
