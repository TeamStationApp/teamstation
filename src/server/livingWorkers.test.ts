import { expect } from 'chai'
import { describe, it } from 'mocha'

import { livingWorkers, type MortalWorker } from './livingWorkers'

const worker = (dead: boolean): MortalWorker & { dead: boolean } => ({
  dead,
  isDead: () => dead
})

describe('livingWorkers', function () {
  it('is empty when there are no workers at all', function () {
    expect(livingWorkers({})).deep.equals([])
    expect(livingWorkers(undefined)).deep.equals([])
  })

  it('counts the ones that are running', function () {
    const alive = worker(false)
    expect(livingWorkers({ 1: alive, 2: worker(true) })).deep.equals([alive])
  })

  /**
   * The production failure: four entries, four dead processes. Counting the
   * entries said the stop was not finished when it was, and nothing else was
   * ever going to say otherwise.
   */
  it('is empty when every entry is a worker that has already gone', function () {
    const workers = { 1: worker(true), 2: worker(true), 3: worker(true) }
    expect(Object.keys(workers)).length(3)
    expect(livingWorkers(workers)).deep.equals([])
  })

  it('ignores a hole left where a worker was', function () {
    const alive = worker(false)
    expect(livingWorkers({ 1: undefined, 2: alive })).deep.equals([alive])
  })
})
