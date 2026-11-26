import { expect } from 'chai'
import { describe, it } from 'mocha'

import { type PgTool, readDumpAccounts } from './dumps'
import { ROOT } from './manifest'
import { validate } from './validate'

describe('validate --strict on the dump worlds', function () {
  this.timeout(120000)

  const listing =
    (extra: string): PgTool =>
    (tool, args) => {
      expect(tool).equals('pg_restore')
      if (args.includes('--list')) {
        return `3600; 0 16390 TABLE DATA public users teamstation\n${extra}`
      }
      return Object.values(readDumpAccounts(ROOT, 'coach-season-dump').accounts)
        .map(account => account.userId)
        .join('\n')
    }

  it('checks each committed dump, and names one carrying rows of a log table', function () {
    const clean = validate(ROOT, { strict: true, pg: listing('') })
    expect(
      clean.problems.filter(problem => problem.includes('fixtures/dumps'))
    ).deep.equals([])
    const carrying = validate(ROOT, {
      strict: true,
      pg: listing(
        '3601; 0 16391 TABLE DATA public scoreboard_log teamstation\n'
      )
    })
    expect(carrying.problems).contains(
      'e2e/fixtures/dumps/coach-season-dump.dump: carries rows of scoreboard_log, which a dump leaves out'
    )
    // Outside --strict no dump is read.
    const loose = validate(ROOT, {
      pg: () => {
        throw new Error('read')
      }
    })
    expect(
      loose.problems.some(problem => problem.includes('fixtures/dumps'))
    ).equals(false)
  })
})
