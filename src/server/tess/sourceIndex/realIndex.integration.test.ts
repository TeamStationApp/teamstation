import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { expect } from 'chai'
import { it } from 'mocha'

import { buildSourceIndex } from './build'
import { sourcePaths } from './files'

it('indexes this checkout exactly and finds contextLimits in production code', function () {
  this.timeout(120000)
  const temp = mkdtempSync(join(tmpdir(), 'tess-real-index-'))
  const out = join(temp, 'source.db')
  try {
    const built = buildSourceIndex({ root: process.cwd(), out })
    const db = new DatabaseSync(out, { readOnly: true })
    try {
      const rows = db
        .prepare('select path,content from files order by path')
        .all()
      const skipped = new Set(built.skipped.map(row => row.path))
      expect(rows.map(row => row.path)).deep.equals(
        sourcePaths(process.cwd()).filter(path => !skipped.has(path))
      )
      for (const row of rows)
        expect(row.content, String(row.path)).equals(
          readFileSync(String(row.path), 'utf8')
        )
      expect(
        rows.some(
          row =>
            String(row.path).startsWith('src/maestro/') ||
            String(row.path).startsWith('src/tools/')
        )
      ).equals(false)
      expect(
        db
          .prepare(
            "select files.path from search join files on files.id=search.rowid where search.content glob '*contextLimits*' and files.role='code'"
          )
          .all()
          .map(row => row.path)
      ).includes('src/server/tess/compaction.ts')
    } finally {
      db.close()
    }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
