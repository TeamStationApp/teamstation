import { expect } from 'chai'
import { describe, it } from 'mocha'

import { HttpError } from '../../common/errors'
import {
  decodeScheduleCursor,
  encodeScheduleCursor,
  firstPage,
  pageAround,
  pageFromCursor,
  pastCursor,
  readingOrder,
  type ScheduleCursor
} from './scheduleCursor'

const START = '2027-04-01T19:00:00.000Z'
const row = (id: string, startAt = START): { id: string; startAt: string } => ({
  id,
  startAt
})
const placed = Array.from({ length: 7 }, (_, index) =>
  row(`gam_${index}`, `2027-04-0${index + 1}T19:00:00.000Z`)
)

function refused(text: string): string {
  try {
    decodeScheduleCursor(text)
  } catch (error) {
    if (error instanceof HttpError) return error.message
    throw error
  }
  throw new Error('expected a 400')
}

function encoded(fields: unknown): string {
  return Buffer.from(JSON.stringify(fields)).toString('base64url')
}

describe('a schedule cursor', function () {
  it('reads back what it wrote', function () {
    const cursor: ScheduleCursor = {
      startAt: START,
      id: 'gam_1',
      direction: 'prev',
      order: 'desc'
    }
    expect(decodeScheduleCursor(encodeScheduleCursor(cursor))).deep.equals(
      cursor
    )
  })

  it('is a 400 for anything it did not write', function () {
    const message = 'cursor is not a cursor this list gave'
    expect(refused('!!!')).equals(message)
    expect(refused(encoded('text'))).equals(message)
    expect(refused(encoded([START, 'gam_1', 'next']))).equals(message)
    expect(refused(encoded(['nope', 'gam_1', 'next', 'asc']))).equals(message)
    expect(refused(encoded(['2027-04-01', 'gam_1', 'next', 'asc']))).equals(
      message
    )
    expect(refused(encoded([START, '', 'next', 'asc']))).equals(message)
    expect(refused(encoded([START, 7, 'next', 'asc']))).equals(message)
    expect(refused(encoded([START, 'gam_1', 'sideways', 'asc']))).equals(
      message
    )
    expect(refused(encoded([START, 'gam_1', 'next', 'random']))).equals(message)
  })

  it('reads the other way to walk back', function () {
    const at = { startAt: START, id: 'gam_1' }
    const read = (
      direction: ScheduleCursor['direction'],
      order: ScheduleCursor['order']
    ): string => readingOrder({ ...at, direction, order })
    expect(read('next', 'asc')).equals('asc')
    expect(read('next', 'desc')).equals('desc')
    expect(read('prev', 'asc')).equals('desc')
    expect(read('prev', 'desc')).equals('asc')
  })

  it('places a row past the cursor by start, then by id', function () {
    const rising: ScheduleCursor = {
      startAt: START,
      id: 'gam_m',
      direction: 'next',
      order: 'asc'
    }
    const falling: ScheduleCursor = { ...rising, order: 'desc' }
    expect(pastCursor(row('gam_a', placed[1].startAt), rising)).equals(true)
    expect(pastCursor(row('gam_a', placed[1].startAt), falling)).equals(false)
    expect(pastCursor(row('gam_z'), rising)).equals(true)
    expect(pastCursor(row('gam_a'), rising)).equals(false)
    expect(pastCursor(row('gam_a'), falling)).equals(true)
    expect(pastCursor(row('gam_m'), rising)).equals(false)
    expect(pastCursor(row('gam_m'), falling)).equals(false)
    // Walking back reads the other way.
    expect(pastCursor(row('gam_a'), { ...rising, direction: 'prev' })).equals(
      true
    )
    // A proposal's start is as it was written, and is the same instant.
    expect(pastCursor(row('gam_m', '2027-04-01T19:00:00Z'), rising)).equals(
      false
    )
  })
})

describe('cutting a page', function () {
  const cursorOf = (text: string | null): ScheduleCursor =>
    decodeScheduleCursor(text ?? '')

  it('leaves a first page by its last row, and only when more follow', function () {
    const page = firstPage(placed, 3, 'asc')
    expect(page.items.map(one => one.id)).deep.equals([
      'gam_0',
      'gam_1',
      'gam_2'
    ])
    expect(cursorOf(page.nextCursor)).deep.equals({
      startAt: placed[2].startAt,
      id: 'gam_2',
      direction: 'next',
      order: 'asc'
    })
    expect(page.prevCursor).equals(null)
    expect(firstPage(placed, 7, 'asc').nextCursor).equals(null)
    expect(cursorOf(firstPage(placed, 3, 'desc').nextCursor).order).equals(
      'desc'
    )
  })

  it('writes a start in one spelling, whatever the row held', function () {
    const page = firstPage(
      [row('pending:1', '2027-04-01T19:00:00Z'), row('gam_2')],
      1,
      'asc'
    )
    expect(cursorOf(page.nextCursor).startAt).equals(START)
  })

  it('reads on with a cursor to the end', function () {
    const cursor: ScheduleCursor = {
      ...placed[1],
      direction: 'next',
      order: 'asc'
    }
    const page = pageFromCursor(placed.slice(2, 6), 3, cursor)
    expect(page.items.map(one => one.id)).deep.equals([
      'gam_2',
      'gam_3',
      'gam_4'
    ])
    expect(cursorOf(page.nextCursor).id).equals('gam_4')
    expect(cursorOf(page.prevCursor)).deep.equals({
      ...placed[2],
      direction: 'prev',
      order: 'asc'
    })
    expect(pageFromCursor(placed.slice(5, 7), 3, cursor).nextCursor).equals(
      null
    )
  })

  it('reads back with a cursor, in list order', function () {
    const cursor: ScheduleCursor = {
      ...placed[5],
      direction: 'prev',
      order: 'asc'
    }
    const page = pageFromCursor(
      [placed[4], placed[3], placed[2], placed[1]],
      3,
      cursor
    )
    expect(page.items.map(one => one.id)).deep.equals([
      'gam_2',
      'gam_3',
      'gam_4'
    ])
    expect(cursorOf(page.prevCursor).id).equals('gam_2')
    expect(cursorOf(page.nextCursor)).deep.equals({
      ...placed[4],
      direction: 'next',
      order: 'asc'
    })
    expect(pageFromCursor([placed[0]], 3, cursor).prevCursor).equals(null)
  })

  it('leaves an empty page from where it was read', function () {
    const forward: ScheduleCursor = {
      ...placed[5],
      direction: 'next',
      order: 'desc'
    }
    const after = pageFromCursor([], 3, forward)
    expect(after.items).deep.equals([])
    expect(after.nextCursor).equals(null)
    expect(cursorOf(after.prevCursor)).deep.equals({
      ...placed[5],
      direction: 'prev',
      order: 'desc'
    })
    const back = pageFromCursor([], 3, {
      ...placed[0],
      direction: 'prev',
      order: 'desc'
    })
    expect(back.prevCursor).equals(null)
    expect(cursorOf(back.nextCursor)).deep.equals({
      ...placed[0],
      direction: 'next',
      order: 'desc'
    })
  })

  it('opens around a row with half a page before it', function () {
    const page = pageAround(placed, 4, 2)
    expect(page.items.map(one => one.id)).deep.equals([
      'gam_3',
      'gam_4',
      'gam_5'
    ])
    expect(cursorOf(page.prevCursor).id).equals('gam_3')
    expect(cursorOf(page.nextCursor).id).equals('gam_5')
    expect(cursorOf(page.prevCursor).order).equals('asc')
    expect(cursorOf(page.nextCursor).order).equals('asc')
  })

  it('has no cursor for a side with no rows', function () {
    const start = pageAround(placed, 0, 2)
    expect(start.items.map(one => one.id)).deep.equals(['gam_0', 'gam_1'])
    expect(start.prevCursor).equals(null)
    const end = pageAround(placed, 6, 3)
    expect(end.items.map(one => one.id)).deep.equals(['gam_5', 'gam_6'])
    expect(end.nextCursor).equals(null)
    expect(pageAround([], 0, 3)).deep.equals({
      items: [],
      nextCursor: null,
      prevCursor: null
    })
  })
})
