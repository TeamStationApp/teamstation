import { expect } from 'chai'
import { before, describe, it } from 'mocha'

import { sql } from '../../test/testSqliteExecutor'
import {
  loadOnce,
  openWasmExecutor,
  wasmSqliteExecutor,
  wasmSqliteReady
} from './wasmSqliteExecutor'

describe('the web cache on SQLite WASM', function () {
  before(wasmSqliteReady)

  it('answers rows as objects, binds params, and nothing for a statement without columns', async function () {
    const executor = await wasmSqliteExecutor()
    expect(
      await sql(executor, 'CREATE TABLE notes (id TEXT, n INTEGER)')
    ).deep.equals([])
    expect(
      await sql(executor, 'INSERT INTO notes VALUES (?, ?)', ['a', 1])
    ).deep.equals([])
    await sql(executor, 'INSERT INTO notes VALUES (?, ?)', ['b', 2])
    expect(
      await sql(
        executor,
        'SELECT id, n FROM notes WHERE n > ? ORDER BY id',
        [0]
      )
    ).deep.equals([
      { id: 'a', n: 1 },
      { id: 'b', n: 2 }
    ])
    expect(await sql(executor, 'SELECT count(*) AS c FROM notes')).deep.equals([
      { c: 2 }
    ])
    await executor.close()
  })

  it('refuses at once in a browser with no WebAssembly, logging nothing', async function () {
    const descriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'WebAssembly'
    )
    const logged: unknown[] = []
    const log = console.error
    console.error = (...args: unknown[]) => {
      logged.push(args)
    }
    Object.defineProperty(globalThis, 'WebAssembly', {
      value: undefined,
      configurable: true
    })
    let refused: unknown
    try {
      await wasmSqliteReady()
    } catch (error) {
      refused = error
    } finally {
      Object.defineProperty(globalThis, 'WebAssembly', descriptor!)
      console.error = log
    }
    expect(String(refused)).includes('no WebAssembly')
    expect(logged).deep.equals([])
    // The module loads as before once WebAssembly is there.
    await wasmSqliteReady()
  })

  it('loads the module once, and asks again after a load that failed', async function () {
    let calls = 0
    const load = loadOnce(async () => {
      calls++
      if (calls === 1) throw new Error('fetch failed')
      return calls
    })
    let refused: unknown
    try {
      await load()
    } catch (error) {
      refused = error
    }
    expect(refused).property('message').equals('fetch failed')
    expect(await load()).equals(2)
    expect(await load()).equals(2)
    expect(calls).equals(2)
  })

  it('rolls a transaction back when its work throws', async function () {
    const executor = openWasmExecutor()
    await sql(executor, 'CREATE TABLE notes (id TEXT)')
    let refused: unknown
    try {
      await executor.transaction(async tx => {
        await tx.execute('INSERT INTO notes VALUES (?)', ['gone'])
        throw new Error('no')
      })
    } catch (error) {
      refused = error
    }
    expect(refused).property('message').equals('no')
    expect(await sql(executor, 'SELECT * FROM notes')).deep.equals([])
    await executor.close()
  })

  it('runs transactions started together one after the other', async function () {
    const executor = openWasmExecutor()
    await sql(executor, 'CREATE TABLE steps (step TEXT)')
    const order: string[] = []
    const first = executor.transaction(async tx => {
      order.push('first in')
      await new Promise(resolve => setTimeout(resolve, 20))
      await tx.execute('INSERT INTO steps VALUES (?)', ['first'])
      order.push('first out')
    })
    const second = executor.transaction(async tx => {
      order.push('second in')
      await tx.execute('INSERT INTO steps VALUES (?)', ['second'])
      order.push('second out')
    })
    await Promise.all([first, second])
    expect(order).deep.equals([
      'first in',
      'first out',
      'second in',
      'second out'
    ])
    await executor.close()
  })

  it('refuses work once closed, closes twice safely, and deletes nothing', async function () {
    const executor = openWasmExecutor()
    await executor.close()
    await executor.close()
    let refused: unknown
    try {
      await sql(executor, 'SELECT 1')
    } catch (error) {
      refused = error
    }
    expect(refused).property('message').equals('The database is closed')
    // Nothing is on disk to remove.
    await executor.delete()
  })

  it('opens a database of its own for each executor', async function () {
    const one = openWasmExecutor()
    const two = openWasmExecutor()
    await sql(one, 'CREATE TABLE only_here (id TEXT)')
    expect(
      await sql(
        two,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'only_here'"
      )
    ).deep.equals([])
    await one.close()
    await two.close()
  })
})
