import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

/**
 * The product is TeamStation, and nothing tracked calls it anything else.
 *
 * Every tracked text file is searched for the old name in each spelling it
 * had — as a word, as an identifier prefix, as an id — and a hit fails unless
 * it is one of the places that must keep it:
 *
 * - migrations 001–046, which are history, recorded by name;
 * - 047 and its test, which rename what those stored;
 * - the legacy codes and the rewrite that read posts from apps built before
 *   TeamStation, and their tests;
 * - the old addresses, which the Caddyfile still answers and comments name;
 * - PeerTube's host, which is not moving.
 */
export const OLD_NAME =
  'GameStation|gameStation|gamestation|GAMESTATION|\\bGS\\b|\\bGS[A-Z_]|\\bgs[A-Z_]|\\bGs[A-Z]|co\\.gamestation'

const KEEP: Array<{ path: RegExp; line?: RegExp }> = [
  { path: /^src\/migrate\/migrations\/0(?:[0-3]\d|4[0-6])[A-Za-z]+\.ts$/ },
  { path: /^src\/migrate\/migrations\/047teamStation\.ts$/ },
  { path: /^src\/migrate\/teamStation\.test\.ts$/ },
  { path: /^src\/common\/gumboEventTypes\.ts$/, line: /\bgs_\w+: 'ts_/ },
  { path: /^src\/common\/gumboPlay\.(test\.)?ts$/ },
  { path: /^src\/deploy\/Caddyfile$/ },
  { path: /^src\/test\/brandSweep\.test\.ts$/ },
  { path: /./, line: /\btube2?\.gamestation\.co\b/ },
  // Plans, by their file names.
  { path: /./, line: /\.cursor\/plans\/\d{12}-\w+\.md/ },
  { path: /^README\.md$/, line: /202609150848-gameStationApp\.md/ },
  // Not names: a lockfile's integrity hashes and OpenType's GSUB table.
  { path: /(^|\/)package-lock\.json$/, line: /"integrity":/ },
  { path: /./, line: /\bGSUB\b|\bGPOS\b/ }
]

/** Each tracked line naming the old product, as `path:line:text`. */
export function oldNameHits(cwd: string): string[] {
  let found: string
  try {
    found = execFileSync('git', ['grep', '-n', '-I', '-P', OLD_NAME], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    })
  } catch (error) {
    // `git grep` exits 1 when nothing matches.
    if ((error as { status?: number }).status === 1) return []
    throw error
  }
  return found
    .split('\n')
    .filter(row => row !== '')
    .filter(row => {
      const [path, , ...rest] = row.split(':')
      const text = rest.join(':')
      return !KEEP.some(
        keep => keep.path.test(path) && (keep.line?.test(text) ?? true)
      )
    })
}

describe('the brand', function () {
  this.timeout(60000)

  it('is TeamStation in every tracked file, outside the places that keep the old name', function () {
    const hits = oldNameHits(join(__dirname, '../..'))
    expect(hits, hits.slice(0, 40).join('\n')).deep.equals([])
  })

  it('finds the old name in a file that is not kept, and passes a kept one', function () {
    const dir = mkdtempSync(join(tmpdir(), 'ts-brand-sweep-'))
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
    try {
      git('init', '-q', '-b', 'master')
      writeFileSync(join(dir, 'clean.ts'), 'export const name = "TeamStation"\n')
      git('add', '.')
      expect(oldNameHits(dir)).deep.equals([])
      writeFileSync(join(dir, 'stray.ts'), 'export const name = "GameStation"\n')
      writeFileSync(join(dir, 'host.md'), 'PeerTube is at tube2.gamestation.co\n')
      git('add', '.')
      expect(oldNameHits(dir)).deep.equals([
        'stray.ts:1:export const name = "GameStation"'
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
