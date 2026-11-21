import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { expect } from 'chai'
import { it } from 'mocha'

import { REAL_INDEX_TIMEOUT, realSourceIndex } from '../../test/realSourceIndex'
import { DIRECTORY_MAP_LIMIT } from './sourceIndex/schema'

it('keeps the compact source map within 4000 characters and names only indexed paths', function () {
  this.timeout(REAL_INDEX_TIMEOUT)
  const map = readFileSync('src/DIRECTORY_MAP.md', 'utf8')
  expect(map.length).at.most(DIRECTORY_MAP_LIMIT)
  const { out } = realSourceIndex()
  const db = new DatabaseSync(out, { readOnly: true })
  try {
    const paths = [...map.matchAll(/`([^`]+)`/g)].map(
      match => `src/${match[1].replace(/\/$/, '')}`
    )
    expect(paths.length).greaterThan(30)
    for (const path of paths)
      expect(
        db
          .prepare(
            'SELECT 1 FROM files WHERE path=? UNION ALL SELECT 1 FROM entries WHERE parent=? LIMIT 1'
          )
          .get(path, path),
        path
      ).not.equals(undefined)
  } finally {
    db.close()
  }
})
