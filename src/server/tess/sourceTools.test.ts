import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { FIXTURE_MAP, sourceIndexFixture } from '../../test/sourceIndexFixture'
import {
  DIRECTORY_MAP,
  isSourceTool,
  openSourceIndex,
  SOURCE_LIMITS,
  SOURCE_QUERY_FAILED,
  SOURCE_TOOLS,
  SOURCE_UNAVAILABLE,
  type SourceIndex,
  sourceIndexPath,
  type SourceToolName
} from './sourceTools'
import { runTool, type ToolContext } from './tools'

const bulk = Object.fromEntries(
  Array.from({ length: 205 }, (_, at) => [
    `src/bulk/f${String(at).padStart(3, '0')}.ts`,
    `export const shared = "repeat needle"\n`
  ])
)

describe('Tess indexed source tools', function () {
  this.timeout(120000)
  let f: ReturnType<typeof sourceIndexFixture>, index: SourceIndex
  before(() => {
    f = sourceIndexFixture({
      ...bulk,
      ...Object.fromEntries(
        Array.from({ length: 105 }, (_, at) => [
          `src/wide/${String(at).padStart(3, '0')}${'w'.repeat(210)}.ts`,
          '/** ' +
            'D'.repeat(500) +
            ' */\nexport const longShared = "' +
            'needle'.repeat(80) +
            '"\n'
        ])
      ),
      'src/tall.txt': ('x'.repeat(1000) + '\n').repeat(30),
      'src/center.txt': 'z'.repeat(1000) + ' targetNeedle ' + 'z'.repeat(1000),
      'src/skipped/binary': Buffer.from([0]),
      'src/lines.txt': Array.from(
        { length: 205 },
        (_, i) => `line ${i + 1}`
      ).join('\n'),
      'src/long.txt': 'z'.repeat(30000) + '\nlast line\n',
      'src/empty.txt': '',
      'src/binary': Buffer.from([0]),
      'src/no-symbols.ts': 'const local = 1',
      'src/test[a]/code.ts':
        'export const literal = ".* [a] $(touch forbidden) a*b a?b *** abc ABC 🦊YZ \\"ab"\n',
      'src/only.test.ts': 'export const onlyTest = 1\n',
      'src/docs.ts':
        '/** A public declaration.\n * Second line. */\nexport function documented() {}\n',
      'src/aliases.ts':
        'const internalValue = 42\nexport { internalValue as publicValue }\n'
    })
    f.build()
    index = openSourceIndex(f.index)
  })
  after(() => {
    f.close()
  })
  const run = (name: SourceToolName, input: unknown): string => {
    const result = index.run(name, input)
    expect(result.is_error, result.content).not.equals(true)
    expect(result.content.length).at.most(SOURCE_LIMITS.outputCharacters)
    return result.content
  }
  it('opens once, caches the complete map/commit and finds the same release from TS or JS', () => {
    expect(openSourceIndex(f.index)).equals(index)
    expect(index.prompt).equals(
      `## TeamStation source at commit fixture-release\n${FIXTURE_MAP}`
    )
    expect(sourceIndexPath(resolve('src/server/tess'))).equals(
      sourceIndexPath(resolve('lib/server/tess'))
    )
    expect(sourceIndexPath()).equals(resolve('lib/server/tess/source.db'))
    expect(SOURCE_TOOLS.map(tool => tool.name)).deep.equals([
      'source_list_directory',
      'source_read_file',
      'source_search',
      'source_outline',
      'source_find_definition'
    ])
    expect(SOURCE_TOOLS.every(tool => isSourceTool(tool.name))).equals(true)
    expect(isSourceTool('write_file')).equals(false)
  })
  it('lists sorted immediate entries across pages with tests and fixtures', () => {
    const page = run('source_list_directory', { path: 'src/bulk' })
    expect(page.split('\n').slice(0, 200)).deep.equals(
      Object.keys(bulk)
        .slice(0, 200)
        .map(path => path.split('/').at(-1))
    )
    expect(page).includes('startEntry 201')
    expect(
      run('source_list_directory', { path: 'src/bulk', startEntry: 201 }).split(
        '\n'
      )
    ).length(5)
    expect(
      run('source_list_directory', { path: 'src/bulk', startEntry: 206 })
    ).equals('[Empty directory.]')
    const root = run('source_list_directory', { path: 'src/' }).split('\n')
    expect(root).deep.equals([...root].sort())
    expect(root).includes('test/').and.includes('only.test.ts')
    expect(run('source_list_directory', { path: 'src/test' })).equals('data.ts')
  })
  it('reads numbered lines, paginates, clips a long line and reads explicit tests', () => {
    const first = run('source_read_file', { path: 'src/lines.txt' })
    expect(first)
      .includes('1: line 1\n')
      .and.includes('200: line 200')
      .and.includes('startLine 201')
    expect(
      run('source_read_file', { path: 'src/lines.txt', startLine: 201 })
    ).equals(
      '201: line 201\n202: line 202\n203: line 203\n204: line 204\n205: line 205'
    )
    expect(
      run('source_read_file', { path: 'src/lines.txt', startLine: 999 })
    ).equals('[End of file.]')
    expect(run('source_read_file', { path: 'src/empty.txt' })).equals(
      '[End of file.]'
    )
    const long = run('source_read_file', { path: 'src/long.txt' })
    expect(long).includes('Line clipped').and.includes('startLine 2')
    expect(
      run('source_read_file', { path: 'src/long.txt', startLine: 2 })
    ).equals('2: last line')
    expect(run('source_read_file', { path: 'src/only.test.ts' })).includes(
      'onlyTest'
    )
    expect(run('source_read_file', { path: DIRECTORY_MAP })).includes(
      'Source directory map'
    )
  })
  it('searches case-sensitive literals and literal paths without interpreting commands or patterns', () => {
    for (const text of [
      '.* [a] $(touch forbidden)',
      'a*b',
      'a?b',
      '[a]',
      '***',
      '🦊YZ',
      '"ab'
    ]) {
      const result = run('source_search', { path: 'src/test[a]', text })
      expect(result).includes('src/test[a]/code.ts:1:')
    }
    expect(
      run('source_search', { path: 'src/test[a]/code.ts', text: 'ABC' })
    ).includes('code.ts:1:')
    expect(run('source_search', { path: 'src/test[a]', text: 'Abc' })).equals(
      '[No matches.]'
    )
    expect(
      index.run('source_search', { path: 'src/*', text: 'abc' }).is_error
    ).equals(true)
    expect(
      run('source_search', {
        path: 'src/server/tess/agent.ts',
        text: 'contextLimits'
      })
    ).not.includes('agent.test')
  })
  it('searches code by default, hints about tests/fixtures and includes them when asked', () => {
    const code = run('source_search', { path: 'src', text: 'contextLimits' })
    expect(code)
      .includes('src/server/tess/agent.ts:3:')
      .and.includes('2 test or fixture files also match')
    expect(code).not.includes('src/test/data.ts:')
    const all = run('source_search', {
      path: 'src',
      text: 'contextLimits',
      includeTests: true
    })
    expect(all).includes('agent.test.ts:').and.includes('src/test/data.ts:')
    expect(all).not.includes('also match')
    expect(run('source_search', { path: 'src/only.test.ts', text: 'onlyTest' }))
      .includes('[No matches.]')
      .and.includes('1 test or fixture')
    expect(run('source_search', { path: 'src/bulk', text: 'repeat' })).includes(
      'Search limited'
    )
  })
  it('outlines recursive code, explicit tests and paginated declarations', () => {
    const code = run('source_outline', { path: 'src/server' })
    expect(code)
      .includes('function contextLimits')
      .and.includes('const MAX_TOOL_ROUNDS')
    expect(code).not.includes('agent.test.ts:')
    expect(
      run('source_outline', { path: 'src/server', includeTests: true })
    ).includes('agent.test.ts:')
    expect(run('source_outline', { path: 'src/only.test.ts' })).includes(
      'onlyTest'
    )
    expect(run('source_outline', { path: 'src/test[a]' })).includes('literal')
    expect(run('source_outline', { path: 'src/no-symbols.ts' })).equals(
      '[No exported symbols.]'
    )
    const bulkPage = run('source_outline', { path: 'src/bulk' })
    const next = /startEntry (\d+)/.exec(bulkPage)!
    expect(next).not.equals(null)
    expect(
      run('source_outline', { path: 'src/bulk', startEntry: Number(next[1]) })
    ).includes('f204.ts:')
    expect(
      run('source_outline', { path: 'src/bulk', startEntry: 1000 })
    ).equals('[No exported symbols.]')
  })
  it('finds exact exported names, first doc lines, test hints and limits', () => {
    expect(run('source_outline', { path: 'src/aliases.ts' })).includes(
      'const publicValue'
    )
    expect(run('source_find_definition', { name: 'publicValue' })).includes(
      'src/aliases.ts:1 const publicValue'
    )
    expect(run('source_find_definition', { name: 'internalValue' })).equals(
      '[No definition named internalValue.]'
    )
    // Code defines it, so there is no nudge towards tests.
    expect(run('source_find_definition', { name: 'contextLimits' }))
      .includes('agent.ts:3 function')
      .and.not.includes('test or fixture')
    expect(
      run('source_find_definition', {
        name: 'contextLimits',
        includeTests: true
      })
    ).includes('agent.test.ts:')
    expect(run('source_find_definition', { name: 'onlyTest' }))
      .includes('[No definition named onlyTest.]')
      .and.includes('1 test or fixture')
    expect(run('source_find_definition', { name: 'documented' }))
      .includes('A public declaration.')
      .and.not.includes('Second line')
    expect(run('source_find_definition', { name: 'noSuchName' })).equals(
      '[No definition named noSuchName.]'
    )
    expect(run('source_find_definition', { name: 'shared' })).includes(
      'Definitions limited'
    )
  })
  it('marks a search limited only when a match is left out, and caps the test hint', () => {
    const f = sourceIndexFixture({
      'src/exact/fifty.ts': 'hit\n'.repeat(SOURCE_LIMITS.matches),
      'src/over/more.ts': 'hit\n'.repeat(SOURCE_LIMITS.matches + 1),
      ...Object.fromEntries(
        Array.from({ length: 101 }, (_, i) => [
          `src/many/case${i}.test.ts`,
          'hitInTests\n'
        ])
      ),
      'src/many/code.ts': 'hitInTests\n'
    })
    try {
      f.build()
      const reader = openSourceIndex(f.index)
      const exact = reader.run('source_search', {
        path: 'src/exact',
        text: 'hit'
      }).content
      expect(exact.split('\n')).length(SOURCE_LIMITS.matches)
      expect(exact).not.includes('Search limited')
      expect(
        reader.run('source_search', { path: 'src/over', text: 'hit' }).content
      ).includes('Search limited')
      expect(
        reader.run('source_search', { path: 'src/many', text: 'hitInTests' })
          .content
      ).includes('[100 or more test or fixture files also match')
    } finally {
      f.close()
    }
  })
  it('bounds long listings, declarations, matches and line pages without losing the next entry', () => {
    const listing = run('source_list_directory', { path: 'src/wide' })
    const next = Number(/startEntry (\d+)/.exec(listing)![1])
    expect(next).lessThan(105)
    expect(
      run('source_list_directory', { path: 'src/wide', startEntry: next })
    ).includes('104')
    expect(run('source_outline', { path: 'src/wide' })).includes('More symbols')
    expect(run('source_find_definition', { name: 'longShared' })).includes(
      'Definitions limited'
    )
    expect(run('source_search', { path: 'src/wide', text: 'needle' })).includes(
      'Search limited'
    )
    expect(
      run('source_search', { path: 'src/center.txt', text: 'targetNeedle' })
    )
      .includes('…')
      .and.includes('targetNeedle')
    const page = run('source_read_file', { path: 'src/tall.txt' })
    expect(page).includes('More lines').and.not.includes('Line clipped')
    expect(
      index.run('source_list_directory', { path: 'src/skipped' }).is_error
    ).equals(true)
  })
  it('reads paths written relative to src, as the map writes them', () => {
    expect(run('source_list_directory', { path: 'bulk' })).equals(
      run('source_list_directory', { path: 'src/bulk' })
    )
    expect(run('source_read_file', { path: 'common/api.ts' })).equals(
      run('source_read_file', { path: 'src/common/api.ts' })
    )
    expect(run('source_list_directory', { path: '' })).equals(
      run('source_list_directory', { path: 'src' })
    )
    const refused = index.run('source_read_file', { path: '/etc/passwd' })
    expect(refused.is_error).equals(true)
    expect(refused.content).includes('server/tess')
  })
  it('reopens an index rebuilt while it was open', () => {
    const g = sourceIndexFixture()
    try {
      g.build()
      const first = openSourceIndex(g.index)
      expect(first.prompt).includes(FIXTURE_MAP)
      g.write('src/DIRECTORY_MAP.md', '# Rebuilt map\n')
      g.build()
      const second = openSourceIndex(g.index)
      expect(second).not.equals(first)
      expect(second.prompt).includes('# Rebuilt map')
      expect(openSourceIndex(g.index)).equals(second)
      // The replaced handle is closed, so a turn still holding it is told so.
      expect(first.run('source_list_directory', { path: 'src' })).deep.equals({
        content: SOURCE_UNAVAILABLE,
        is_error: true
      })
    } finally {
      g.close()
    }
  })
  it('refuses malformed input and paths before querying unindexed data', () => {
    for (const input of [null, [], 'text', 1])
      expect(index.run('source_search', input).is_error).equals(true)
    for (const path of [
      'package.json',
      '/src/a',
      'src/../package.json',
      'src/a\\b',
      'src/a\0b',
      'src/' + 'a'.repeat(4096),
      'src/missing',
      'src/binary'
    ])
      expect(index.run('source_read_file', { path }).is_error, path).equals(
        true
      )
    for (const text of [
      '',
      'ab',
      '🦊',
      'a'.repeat(501),
      'a\nb',
      'a\rb',
      'abc\0'
    ])
      expect(index.run('source_search', { path: 'src', text }).is_error).equals(
        true
      )
    for (const value of [0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        index.run('source_read_file', {
          path: 'src/common/api.ts',
          startLine: value
        }).is_error
      ).equals(true)
      expect(
        index.run('source_list_directory', { path: 'src', startEntry: value })
          .is_error
      ).equals(true)
    }
    for (const name of ['', 3, 'a'.repeat(501), 'a\nb'])
      expect(index.run('source_find_definition', { name }).is_error).equals(
        true
      )
    expect(
      index.run('source_search', {
        path: 'src',
        text: 'abc',
        includeTests: 'yes'
      }).is_error
    ).equals(true)
    expect(
      index.run('source_list_directory', { path: 'src/common/api.ts' }).is_error
    ).equals(true)
    expect(
      index.run('source_read_file', { path: 'src/common' }).is_error
    ).equals(true)
  })
  it('dispatches all five tools for any user and fails safely without an index', async () => {
    const context: ToolContext = {
      db: null as never,
      userId: 'usr_fixture',
      credentials: {},
      origin: 'http://example.test',
      now: new Date(),
      proposals: { count: 0 },
      source: index
    }
    const inputs = [
      { path: 'src' },
      { path: 'src/common/api.ts' },
      { path: 'src', text: 'contextLimits' },
      { path: 'src/server' },
      { name: 'contextLimits' }
    ]
    for (const [i, tool] of SOURCE_TOOLS.entries()) {
      const outcome = await runTool(context, {
        id: 'tool',
        type: 'tool_use',
        name: tool.name,
        input: inputs[i]
      })
      expect(outcome.result.is_error).not.equals(true)
    }
    expect(
      (
        await runTool(
          { ...context, source: undefined },
          {
            id: 'tool',
            type: 'tool_use',
            name: 'source_outline',
            input: { path: 'src' }
          }
        )
      ).result.is_error
    ).equals(true)
  })
  it('reports missing, corrupt, incompatible and incomplete indexes once per path', () => {
    const warn = console.warn
    const warnings: unknown[][] = []
    console.warn = (...args) => warnings.push(args)
    const fixtures: Array<ReturnType<typeof sourceIndexFixture>> = []
    try {
      for (const kind of [
        'missing',
        'corrupt',
        'schema',
        'map',
        'longmap',
        'table'
      ]) {
        const bad = sourceIndexFixture()
        fixtures.push(bad)
        if (kind !== 'missing') bad.build()
        if (kind === 'corrupt') writeFileSync(bad.index, 'not sqlite')
        else if (kind !== 'missing') {
          const db = new DatabaseSync(bad.index)
          if (kind === 'schema')
            db.exec("UPDATE meta SET value='99' WHERE key='schema_version'")
          if (kind === 'map')
            db.prepare('DELETE FROM files WHERE path=?').run(DIRECTORY_MAP)
          if (kind === 'longmap')
            db.prepare('UPDATE files SET content=? WHERE path=?').run(
              'x'.repeat(4001),
              DIRECTORY_MAP
            )
          if (kind === 'table') db.exec('DROP TABLE symbols')
          db.close()
        }
        const unavailable = openSourceIndex(bad.index)
        expect(unavailable.prompt).equals(SOURCE_UNAVAILABLE)
        for (const tool of SOURCE_TOOLS)
          expect(unavailable.run(tool.name as SourceToolName, {})).deep.equals({
            content: SOURCE_UNAVAILABLE,
            is_error: true
          })
        if (kind === 'missing') {
          // A missing file is retried, so an index built later is picked up.
          expect(openSourceIndex(bad.index).prompt).equals(SOURCE_UNAVAILABLE)
          bad.build()
          expect(openSourceIndex(bad.index).prompt).not.equals(
            SOURCE_UNAVAILABLE
          )
        } else expect(openSourceIndex(bad.index)).equals(unavailable)
      }
      expect(warnings).length(6)
      expect(String(warnings[0][0])).includes('npm run tess.source-index')
    } finally {
      console.warn = warn
      for (const bad of fixtures) bad.close()
    }
  })
  it('uses the trigram even for punctuation patterns, avoiding unrelated external-content reads', () => {
    const f = sourceIndexFixture({
      'src/trap.ts': 'unrelated contents without requested punctuation'
    })
    try {
      f.build()
      const db = new DatabaseSync(f.index)
      db.exec(`ALTER TABLE files RENAME TO originals;
        CREATE VIEW files AS SELECT id AS rowid,id,path,directory,role,lines,bytes,
        CASE WHEN path='src/trap.ts' THEN abs(-9223372036854775808) ELSE content END AS content FROM originals;`)
      db.close()
      const reader = openSourceIndex(f.index)
      for (const text of ['a*b', '[a]', '***', '"ab', '🦊YZ'])
        expect(reader.run('source_search', { path: 'src', text })).deep.equals({
          content: '[No matches.]'
        })
      // A direct read really reaches the trap. The error fails that call
      // only, is logged with its tool, and later calls still work.
      const warn = console.warn
      const warnings: unknown[][] = []
      console.warn = (...args) => warnings.push(args)
      try {
        expect(
          reader.run('source_read_file', { path: 'src/trap.ts' })
        ).deep.equals({ content: SOURCE_QUERY_FAILED, is_error: true })
        expect(warnings[0][1]).includes({ tool: 'source_read_file' })
        expect(
          reader.run('source_search', { path: 'src', text: 'abc' })
        ).deep.equals({ content: '[No matches.]' })
        expect(
          reader.run('source_read_file', { path: 'src/trap.ts' }).content
        ).equals(SOURCE_QUERY_FAILED)
        expect(warnings).length(2)
      } finally {
        console.warn = warn
      }
    } finally {
      f.close()
    }
  })
})
