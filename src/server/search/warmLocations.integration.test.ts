import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

/**
 * `warmLocations` in a process of its own, whose catalog nothing has read
 * yet, as a server worker runs it once it listens.
 */
describe('warming the location pills', () => {
  /** Runs this script in a fresh process and reads the JSON it prints last. */
  function fresh<T>(script: string): T {
    const output = execFileSync(
      process.execPath,
      ['-r', 'sucrase/register', '-e', script],
      { cwd: resolve(__dirname, '../../..'), encoding: 'utf8' }
    )
    return JSON.parse(output.trim().split('\n').pop() ?? '{}') as T
  }

  it('builds in short stretches, leaving the event loop free, and answers the first search at once', function () {
    this.timeout(60000)
    const timed = fresh<{
      longestMs: number
      firstMs: number
      pills: number
      places: number
      waited: boolean
    }>(`
      const { monitorEventLoopDelay, performance } = require('node:perf_hooks')
      const { findPlaces } = require('./src/server/location/places')
      const {
        findLocations,
        locationsReady,
        warmLocations
      } = require('./src/server/search/locations')
      ;(async () => {
        const delay = monitorEventLoopDelay({ resolution: 5 })
        delay.enable()
        const warmed = warmLocations()
        // A search that arrives meanwhile waits for the warm.
        let waited = false
        const ready = locationsReady().then(() => { waited = true })
        await warmed
        await ready
        delay.disable()
        const started = performance.now()
        const pills = findLocations('springfield').length
        const places = findPlaces('bos').length
        const firstMs = performance.now() - started
        console.log(JSON.stringify({
          longestMs: delay.max / 1e6, firstMs, pills, places, waited
        }))
      })()
    `)
    expect(timed.waited).equals(true)
    expect(timed.pills).greaterThan(0)
    expect(timed.places).greaterThan(0)
    expect(timed.firstMs).lessThan(20)
    // The whole build takes several hundred milliseconds; no stretch of it
    // holds the loop for more than a few tens.
    expect(timed.longestMs).lessThan(100)
  })

  it('answers as a build made at once does, and a search during the warm answers the same', function () {
    this.timeout(60000)
    const same = fresh<{ rows: boolean; during: boolean; answers: boolean }>(`
      const { readFileSync } = require('node:fs')
      const { gunzipSync } = require('node:zlib')
      const places = require('./src/server/location/places')
      const { findLocations, warmLocations } = require('./src/server/search/locations')
      const texts = ['bos', 'san juan', 'springfield il', 'zz', 'new york', 'québec']
      ;(async () => {
        const warmed = warmLocations()
        // Asked before the warm is done: built at once, the same answer.
        await new Promise(resolve => setImmediate(resolve))
        const early = JSON.stringify(places.findPlaces('springfield'))
        await warmed
        const catalog = places.placeCatalog()
        const parsed = JSON.parse(
          gunzipSync(readFileSync('./src/server/location/placesCatalog.json.gz')).toString()
        )
        const rows = JSON.stringify(catalog) === JSON.stringify(parsed)
        // A copy is a catalog of its own: indexed at once on first use.
        const copy = [...catalog]
        const answers = texts.every(text =>
          JSON.stringify(findLocations(text)) === JSON.stringify(findLocations(text, copy)) &&
          JSON.stringify(places.findPlaces(text)) === JSON.stringify(places.findPlaces(text, copy))
        )
        const during = early === JSON.stringify(places.findPlaces('springfield', copy))
        console.log(JSON.stringify({ rows, during, answers }))
      })()
    `)
    expect(same).deep.equals({ rows: true, during: true, answers: true })
  })
})
