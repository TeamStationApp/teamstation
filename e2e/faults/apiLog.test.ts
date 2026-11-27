import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { ApiLogTail } from './apiLog'

function logFile(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'e2e-api-log-')), 'api.log')
  writeFileSync(path, text)
  return path
}

describe('the API log tail', function () {
  it('stamps each line when it first reads it, and answers those since a time', function () {
    let clock = 100
    const path = logFile('worker 1 listening\nsearch places ready\n')
    const tail = new ApiLogTail(path, { pollMs: 0, now: () => clock })
    expect(tail.since(0)).deep.equals([
      { at: 100, text: 'worker 1 listening' },
      { at: 100, text: 'search places ready' }
    ])
    clock = 200
    appendFileSync(path, 'jev: ranked by jev-1\n')
    expect(tail.since(150)).deep.equals([
      { at: 200, text: 'jev: ranked by jev-1' }
    ])
    expect(tail.since(201)).deep.equals([])
    expect(tail.since(0).length).equals(3)
  })

  it('keeps a line without its newline until the rest arrives', function () {
    let clock = 1
    const path = logFile('worker 1: api_rate_dec')
    const tail = new ApiLogTail(path, { pollMs: 0, now: () => clock })
    expect(tail.since(0)).deep.equals([])
    clock = 2
    appendFileSync(path, 'isions {"n":3}\nworker 2: ')
    expect(tail.since(0)).deep.equals([
      { at: 2, text: 'worker 1: api_rate_decisions {"n":3}' }
    ])
  })

  it('starts again from the top of a file that was truncated', function () {
    const path = logFile('one\ntwo\nthree\n')
    const tail = new ApiLogTail(path, { pollMs: 0, now: () => 5 })
    expect(tail.since(0).map(line => line.text)).deep.equals([
      'one',
      'two',
      'three'
    ])
    writeFileSync(path, 'four\n')
    expect(tail.since(0).map(line => line.text)).deep.equals([
      'one',
      'two',
      'three',
      'four'
    ])
  })

  it('keeps only the newest lines', function () {
    const path = logFile('a\nb\nc\nd\n')
    const tail = new ApiLogTail(path, { pollMs: 0, keep: 2, now: () => 1 })
    expect(tail.since(0).map(line => line.text)).deep.equals(['c', 'd'])
  })

  it('throws while the file cannot be read, and reads it once it can', function () {
    const path = join(mkdtempSync(join(tmpdir(), 'e2e-api-log-')), 'api.log')
    const tail = new ApiLogTail(path, { pollMs: 0, now: () => 1 })
    expect(() => tail.since(0)).to.throw(/ENOENT/)
    writeFileSync(path, 'up\n')
    expect(tail.since(0)).deep.equals([{ at: 1, text: 'up' }])
  })

  it('reads on its own while nobody asks, stamping lines near when they were written', async function () {
    let clock = 10
    const path = logFile('')
    const tail = new ApiLogTail(path, { pollMs: 5, now: () => clock })
    try {
      appendFileSync(path, 'early\n')
      await new Promise(resolve => setTimeout(resolve, 40))
      clock = 99
      expect(tail.since(0)).deep.equals([{ at: 10, text: 'early' }])
    } finally {
      tail.close()
    }
  })
})
