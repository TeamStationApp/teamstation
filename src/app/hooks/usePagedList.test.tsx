import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { Page } from '../../common/api'
import { pageOf } from '../../test/pageOf'
import { type PagedRows, usePagedList } from './usePagedList'

interface Row {
  id: string
  note?: string
}

const rowsOf = (from: number, count: number): Row[] =>
  Array.from({ length: count }, (_v, index) => ({ id: `r${from + index}` }))
const ids = (rows: readonly Row[]): string[] => rows.map(row => row.id)
const counts = {
  total: 1,
  upcoming: 0,
  withVideo: 0,
  videos: 0,
  newestSeasonId: null
}

type Read = (cursor: string | null) => Promise<Page<Row>>

let root: Root | undefined
let list!: PagedRows<Row>
let setKey!: (key: string) => void

function Harness(props: {
  read: Read
  listKey: string
  screenRows?: number
}): null {
  const { read, screenRows } = props
  const [listKey, set] = useState(props.listKey)
  setKey = set
  list = usePagedList<Row>({
    listKey,
    read,
    keyOf: row => row.id,
    screenRows
  })
  return null
}

async function open(read: Read, screenRows = 2): Promise<void> {
  const host = document.createElement('div')
  root = createRoot(host)
  await act(async () => {
    root!.render(<Harness read={read} listKey="a" screenRows={screenRows} />)
  })
  await settled()
}

async function settled(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

/** A read that answers when told, for a page held on its way. */
function held(): {
  read: Read
  calls: Array<string | null>
  answer: (page: Page<Row>) => Promise<void>
  fail: () => Promise<void>
} {
  const calls: Array<string | null> = []
  const waiting: Array<{
    resolve: (page: Page<Row>) => void
    reject: (error: Error) => void
  }> = []
  return {
    calls,
    read: async cursor => {
      calls.push(cursor)
      return await new Promise((resolve, reject) => {
        waiting.push({ resolve, reject })
      })
    },
    answer: async page => {
      await act(async () => {
        waiting.shift()!.resolve(page)
      })
      await settled()
    },
    fail: async () => {
      await act(async () => {
        waiting.shift()!.reject(new Error('down'))
      })
      await settled()
    }
  }
}

/** A read over `rows`, counting its calls. */
function over(
  rows: () => readonly Row[],
  limit: number
): { read: Read; calls: Array<string | null> } {
  const calls: Array<string | null> = []
  return {
    calls,
    read: async cursor => {
      calls.push(cursor)
      return pageOf(rows(), { cursor, limit }, { counts })
    }
  }
}

describe('usePagedList', function () {
  afterEach(async function () {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })

  describe('reading on from either end', function () {
    it('appends the next page, one read at a time, and stops at the end', async function () {
      const rows = rowsOf(0, 6)
      const read = held()
      await open(read.read)
      await read.answer(pageOf(rows, { limit: 3 }))
      expect(ids(list.rows)).deep.equals(['r0', 'r1', 'r2'])
      expect(list.loadingMore).equals(false)
      await act(async () => {
        list.loadMore().catch(() => undefined)
        list.loadMore().catch(() => undefined)
      })
      expect(list.loadingMore).equals(true)
      expect(read.calls).deep.equals([null, 'next:3'])
      await read.answer(pageOf(rows, { cursor: 'next:3', limit: 3 }))
      expect(ids(list.rows)).deep.equals(ids(rows))
      await act(async () => {
        await list.loadMore()
      })
      expect(read.calls).deep.equals([null, 'next:3'])
    })

    it('prepends older rows and walks past the first older page', async function () {
      const rows = rowsOf(0, 9)
      const { read, calls } = {
        calls: [] as Array<string | null>,
        read: (async cursor => {
          calls.push(cursor)
          return pageOf(rows, { cursor, limit: 3 }, { anchorIndex: 6 })
        }) as Read
      }
      await open(read)
      expect(ids(list.rows)).deep.equals(['r5', 'r6', 'r7', 'r8'])
      await act(async () => {
        await list.loadOlder()
      })
      expect(ids(list.rows)).deep.equals(ids(rows.slice(2)))
      await act(async () => {
        await list.loadOlder()
      })
      expect(ids(list.rows)).deep.equals(ids(rows))
      expect(calls).deep.equals([null, 'prev:5', 'prev:2'])
      await act(async () => {
        await list.loadOlder()
      })
      expect(calls.length).equals(3)
    })

    it('holds an older page until it may land, and reads on from there', async function () {
      const rows = rowsOf(0, 9)
      const reading = held()
      await open(reading.read, 3)
      await reading.answer(pageOf(rows, { limit: 3 }, { anchorIndex: 6 }))
      const from = ids(list.rows)
      let land!: () => void
      const landing = list.loadOlder(async () => {
        await new Promise<void>(resolve => {
          land = resolve
        })
      })
      await settled()
      await reading.answer(pageOf(rows, { cursor: 'prev:5', limit: 5 }))
      expect(ids(list.rows)).deep.equals(from)
      await act(async () => {
        land()
        await landing
      })
      expect(ids(list.rows)).deep.equals(ids(rows))
    })

    it('drops a held older page when the list changes', async function () {
      const rows = rowsOf(0, 9)
      const reading = held()
      await open(reading.read, 3)
      await reading.answer(pageOf(rows, { limit: 3 }, { anchorIndex: 6 }))
      let land!: () => void
      const landing = list.loadOlder(async () => {
        await new Promise<void>(resolve => {
          land = resolve
        })
      })
      await settled()
      await reading.answer(pageOf(rows, { cursor: 'prev:5', limit: 5 }))
      await act(async () => {
        setKey('b')
      })
      await reading.answer(pageOf(rowsOf(20, 3)))
      await act(async () => {
        land()
        await landing
      })
      expect(ids(list.rows)).deep.equals(['r20', 'r21', 'r22'])
    })

    it('holds each row once when a page repeats one', async function () {
      const pages: Array<Page<Row>> = [
        {
          items: rowsOf(0, 3),
          nextCursor: 'more',
          prevCursor: null,
          anchorId: null,
          counts
        },
        {
          items: rowsOf(2, 3),
          nextCursor: null,
          prevCursor: null,
          anchorId: null,
          counts: null
        }
      ]
      await open(async () => pages.shift()!, 2)
      await act(async () => {
        await list.loadMore()
      })
      expect(ids(list.rows)).deep.equals(['r0', 'r1', 'r2', 'r3', 'r4'])
    })

    it('keeps a repeated row where it first came, as it last read', async function () {
      const pages: Array<Page<Row>> = [
        {
          items: rowsOf(0, 3),
          nextCursor: 'more',
          prevCursor: null,
          anchorId: null,
          counts
        },
        {
          items: [{ id: 'r1', note: 'read again' }, ...rowsOf(3, 1)],
          nextCursor: null,
          prevCursor: null,
          anchorId: null,
          counts: null
        }
      ]
      await open(async () => pages.shift()!, 2)
      await act(async () => {
        await list.loadMore()
      })
      expect(ids(list.rows)).deep.equals(['r0', 'r1', 'r2', 'r3'])
      expect(list.rows[1].note).equals('read again')
    })

    it('drops a page still on its way for the last filter', async function () {
      const read = held()
      await open(read.read)
      await read.answer(pageOf(rowsOf(0, 6), { limit: 3 }))
      await act(async () => {
        list.loadMore().catch(() => undefined)
      })
      await act(async () => {
        setKey('b')
      })
      expect(list.rows).deep.equals([])
      expect(list.loading).equals(true)
      // The new filter's first page, then the old filter's late one.
      await read.answer(pageOf(rowsOf(0, 6), { cursor: 'next:3', limit: 3 }))
      expect(list.rows).deep.equals([])
      await read.answer(pageOf(rowsOf(100, 3), { limit: 3 }))
      expect(ids(list.rows)).deep.equals(['r100', 'r101', 'r102'])
    })
  })

  describe('refreshing', function () {
    it('splices a first page over the rows it covers, keeping what was scrolled through', async function () {
      let rows = rowsOf(0, 9)
      const { read, calls } = over(() => rows, 3)
      await open(read)
      await act(async () => {
        await list.loadMore()
      })
      const before = list.rows
      rows = [{ id: 'new' }, ...rows.slice(0, 2), ...rows.slice(2)]
      await act(async () => {
        await list.refresh()
      })
      expect(ids(list.rows)).deep.equals([
        'new',
        'r0',
        'r1',
        'r2',
        'r3',
        'r4',
        'r5'
      ])
      expect(list.rows[1]).equals(before[0])
      expect(list.rows[6]).equals(before[5])
      expect(calls.at(-1)).equals(null)
      // The cursor is still the end of what is held.
      await act(async () => {
        await list.loadMore()
      })
      expect(calls.at(-1)).equals('next:6')
    })

    it('replaces the list when the page does not reach a held row', async function () {
      let rows = rowsOf(0, 6)
      const { read } = over(() => rows, 3)
      await open(read)
      await act(async () => {
        await list.loadMore()
      })
      rows = rowsOf(50, 3)
      await act(async () => {
        await list.refresh()
      })
      expect(ids(list.rows)).deep.equals(['r50', 'r51', 'r52'])
      rows = []
      await act(async () => {
        await list.refresh()
      })
      expect(list.rows).deep.equals([])
      expect(list.empty).equals(true)
    })

    it('leaves an unchanged list as it was, and older rows above it alone', async function () {
      const rows = rowsOf(0, 9)
      await open(async cursor =>
        pageOf(rows, { cursor, limit: 3 }, { anchorIndex: 6 })
      )
      await act(async () => {
        await list.loadOlder()
      })
      const before = list.rows
      await act(async () => {
        await list.refresh()
      })
      expect(list.rows).equals(before)
    })

    it('changes one row and takes one away', async function () {
      const rows = rowsOf(0, 9)
      await open(async cursor =>
        pageOf(rows, { cursor, limit: 3 }, { anchorIndex: 6 })
      )
      await act(async () => {
        await list.loadOlder()
      })
      const others = list.rows[0]
      await act(async () => {
        list.update('r3', row => ({ ...row, note: 'saved' }))
      })
      expect(list.rows.find(row => row.id === 'r3')?.note).equals('saved')
      expect(list.rows[0]).equals(others)
      await act(async () => {
        list.remove('r2')
        list.remove('r8')
        list.remove('missing')
      })
      expect(ids(list.rows)).deep.equals(['r3', 'r4', 'r5', 'r6', 'r7'])
    })

    it('reads on when a removal leaves the list short, as a short page does', async function () {
      const rows = rowsOf(0, 9)
      const { read, calls } = over(() => rows, 3)
      await open(read, 3)
      calls.length = 0
      await act(async () => {
        list.remove('r0')
      })
      await settled()
      expect(calls).deep.equals(['next:3'])
      expect(ids(list.rows)).deep.equals(['r1', 'r2', 'r3', 'r4', 'r5'])
      calls.length = 0
      await act(async () => {
        list.remove('r1')
      })
      await settled()
      expect(calls).deep.equals([])
    })

    it('re-reads every held page in place', async function () {
      let rows = rowsOf(0, 9)
      const { read, calls } = over(() => rows, 3)
      await open(read)
      await act(async () => {
        await list.loadMore()
      })
      const length = list.rows.length
      const untouched = list.rows[0]
      rows = rows.map(row =>
        row.id === 'r4' ? { ...row, note: 'signed up' } : row
      )
      calls.length = 0
      await act(async () => {
        await list.refreshHeld()
      })
      expect(calls).deep.equals([null, 'next:3'])
      expect(list.rows.length).equals(length)
      expect(list.rows[4].note).equals('signed up')
      expect(list.rows[0]).equals(untouched)
      await act(async () => {
        await list.loadMore()
      })
      expect(calls.at(-1)).equals('next:6')
    })

    it('keeps a page that landed behind a read of the held pages', async function () {
      const rows = rowsOf(0, 9)
      const gate: { hold?: Promise<void> } = {}
      let release: () => void = () => undefined
      const calls: Array<string | null> = []
      await open(async cursor => {
        calls.push(cursor)
        const page = pageOf(rows, { cursor, limit: 3 })
        // Only the read of the held pages waits, not the page that overtakes.
        if (cursor == null) await gate.hold
        return page
      })
      gate.hold = new Promise(resolve => {
        release = resolve
      })
      const reading = list.refreshHeld()
      await act(async () => {
        await list.loadMore()
      })
      expect(ids(list.rows)).deep.equals(ids(rowsOf(0, 6)))
      await act(async () => {
        release()
        await reading
      })
      expect(ids(list.rows)).deep.equals(ids(rowsOf(0, 6)))
      calls.length = 0
      await act(async () => {
        await list.loadMore()
      })
      expect(calls).deep.equals(['next:6'])
      expect(list.rows).has.length(9)
    })

    it('re-reads from the older rows held above the first page', async function () {
      let rows = rowsOf(0, 9)
      await open(async cursor =>
        pageOf(rows, { cursor, limit: 3 }, { anchorIndex: 6 })
      )
      await act(async () => {
        await list.loadOlder()
      })
      expect(ids(list.rows)).deep.equals(ids(rows.slice(2)))
      rows = rows.map(row =>
        row.id === 'r2' ? { ...row, note: 'signed up' } : row
      )
      await act(async () => {
        await list.refreshHeld()
      })
      expect(ids(list.rows)).deep.equals(ids(rows.slice(2)))
      expect(list.rows[0].note).equals('signed up')
      await act(async () => {
        await list.loadOlder()
      })
      expect(ids(list.rows)).deep.equals(ids(rows))
    })

    it('drops a refresh that a later one overtakes', async function () {
      const reading = held()
      await open(reading.read)
      await reading.answer(pageOf(rowsOf(0, 3)))
      const first = list.refresh()
      const second = list.refresh()
      await settled()
      await reading.answer(pageOf(rowsOf(10, 3)))
      await reading.answer(pageOf(rowsOf(20, 3)))
      await act(async () => {
        await Promise.all([first, second])
      })
      expect(ids(list.rows)).deep.equals(['r20', 'r21', 'r22'])
    })

    it('lays a first page the screen read over the list', async function () {
      const reading = held()
      await open(reading.read)
      await reading.answer(pageOf(rowsOf(0, 3)))
      await act(async () => {
        await list.apply(pageOf(rowsOf(0, 4), { limit: 4 }))
      })
      expect(ids(list.rows)).deep.equals(['r0', 'r1', 'r2', 'r3'])
    })

    it('reads the first page when nothing is held to read again', async function () {
      const reading = held()
      await open(reading.read)
      await reading.answer(pageOf([]))
      const again = list.refreshHeld()
      await settled()
      await reading.answer(pageOf(rowsOf(0, 2)))
      await act(async () => {
        await again
      })
      expect(ids(list.rows)).deep.equals(['r0', 'r1'])
    })

    it('keeps the rows when a refresh fails', async function () {
      let down = false
      await open(async cursor => {
        if (down) throw new Error('down')
        return pageOf(rowsOf(0, 6), { cursor, limit: 3 })
      })
      const before = list.rows
      down = true
      await act(async () => {
        await list.refresh()
      })
      expect(list.rows).equals(before)
      expect((list.error as Error).message).equals('down')
      await act(async () => {
        await list.refreshHeld()
      })
      expect(list.rows).equals(before)
      down = false
      await act(async () => {
        await list.refresh()
      })
      expect(list.error).equals(undefined)
    })

    it('paints a stored page under the server, never over it', async function () {
      const read = held()
      await open(read.read)
      const stored = pageOf(rowsOf(0, 3), { limit: 3 })
      await act(async () => {
        list.paint(stored)
      })
      expect(ids(list.rows)).deep.equals(['r0', 'r1', 'r2'])
      expect(list.loading).equals(false)
      const painted = list.rows[0]
      await read.answer(pageOf(rowsOf(0, 3), { limit: 3 }))
      expect(list.rows[0]).equals(painted)
      await act(async () => {
        list.paint(pageOf(rowsOf(50, 3), { limit: 3 }))
      })
      expect(ids(list.rows)).deep.equals(['r0', 'r1', 'r2'])
    })
  })

  describe('a short page, and a failure', function () {
    it('keeps the rows, shows Retry, and retries once', async function () {
      const read = held()
      await open(read.read)
      const rows = rowsOf(0, 6)
      await read.answer(pageOf(rows, { limit: 3 }))
      await act(async () => {
        list.loadMore().catch(() => undefined)
      })
      await read.fail()
      expect(list.failed).equals(true)
      expect(list.loadingMore).equals(false)
      expect(list.rows.length).equals(3)
      expect(read.calls).deep.equals([null, 'next:3'])
      await act(async () => {
        list.retry().catch(() => undefined)
      })
      expect(list.failed).equals(false)
      expect(read.calls).deep.equals([null, 'next:3', 'next:3'])
      await read.answer(pageOf(rows, { cursor: 'next:3', limit: 3 }))
      expect(list.rows.length).equals(6)
      await act(async () => {
        await list.retry()
      })
      expect(read.calls.length).equals(3)
    })

    it('reads on after a page that leaves the screen short, until one fills it', async function () {
      const pages: Array<Page<Row>> = [
        pageOf(rowsOf(0, 1), { limit: 1 }),
        {
          items: [],
          nextCursor: 'b',
          prevCursor: null,
          anchorId: null,
          counts: null
        },
        {
          items: rowsOf(1, 1),
          nextCursor: 'c',
          prevCursor: null,
          anchorId: null,
          counts: null
        },
        {
          items: rowsOf(2, 4),
          nextCursor: 'd',
          prevCursor: null,
          anchorId: null,
          counts: null
        }
      ]
      pages[0].nextCursor = 'a'
      const calls: Array<string | null> = []
      await open(async cursor => {
        calls.push(cursor)
        return pages.shift()!
      }, 3)
      expect(calls).deep.equals([null, 'a', 'b', 'c'])
      expect(list.rows.length).equals(6)
    })

    it('stops the walk at Retry, and goes on from there', async function () {
      const read = held()
      await open(read.read, 3)
      await read.answer({
        items: rowsOf(0, 1),
        nextCursor: 'a',
        prevCursor: null,
        anchorId: null,
        counts: null
      })
      await read.fail()
      expect(list.failed).equals(true)
      expect(read.calls).deep.equals([null, 'a'])
      await act(async () => {
        list.loadMore().catch(() => undefined)
      })
      expect(read.calls).deep.equals([null, 'a', 'a'])
      await read.answer({
        items: rowsOf(1, 3),
        nextCursor: null,
        prevCursor: null,
        anchorId: null,
        counts: null
      })
      expect(list.failed).equals(false)
      expect(list.rows.length).equals(4)
    })

    it('shows the spinner over an empty first page with a cursor, then the empty message at the end', async function () {
      const read = held()
      await open(read.read)
      expect(list.loading).equals(true)
      await read.answer({
        items: [],
        nextCursor: 'a',
        prevCursor: null,
        anchorId: null,
        counts: null
      })
      expect(list.loading).equals(true)
      expect(list.empty).equals(false)
      await read.answer({
        items: [],
        nextCursor: null,
        prevCursor: null,
        anchorId: null,
        counts: null
      })
      expect(list.loading).equals(false)
      expect(list.empty).equals(true)
    })

    it('says so when a first read fails, and shows no empty message', async function () {
      const read = held()
      await open(read.read)
      await read.fail()
      expect(list.loading).equals(false)
      expect(list.empty).equals(false)
      expect((list.error as Error).message).equals('down')
    })
  })
})
