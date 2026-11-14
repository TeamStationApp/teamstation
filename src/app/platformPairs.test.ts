import { readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

/**
 * Metro tries `.native` within each source extension before the next
 * extension, so `x.ts` beside `x.native.tsx` gives a phone the web file.
 * A module and its native twin share one extension.
 */
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]
  )
}

describe('web and native module pairs', function () {
  it('share one extension, so a phone resolves the native file', function () {
    const root = join(__dirname)
    const all = new Set(files(root).map(file => relative(root, file)))
    const mismatched: string[] = []
    for (const file of all) {
      const match = /^(.*)\.native\.(tsx?)$/.exec(file)
      if (match == null) continue
      const [, base, ext] = match
      const other = ext === 'ts' ? 'tsx' : 'ts'
      if (all.has(`${base}.${other}`) && !all.has(`${base}.${ext}`))
        mismatched.push(`${base}.${other} beside ${file}`)
    }
    expect(mismatched).deep.equals([])
  })
})
