import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { expect } from 'chai'
import { it } from 'mocha'

import { buildSourceIndex } from './sourceIndex/build'

it('keeps the compact source map within 4000 characters and names only indexed paths', function () {
  this.timeout(120000)
  const map = readFileSync('src/DIRECTORY_MAP.md', 'utf8')
  expect(map.length).at.most(4000)
  const temp = mkdtempSync(join(tmpdir(), 'tess-map-index-'))
  try {
    const out = join(temp, 'source.db')
    buildSourceIndex({ root: process.cwd(), out })
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
  } finally {
    rmSync(temp, { force: true, recursive: true })
  }
})
