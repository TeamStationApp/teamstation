import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import {
  DIRECTORY_MAP,
  isSourceTool,
  MAP_FIRST,
  SOURCE_LIMITS,
  SOURCE_TOOLS,
  sourceBrowser,
  sourceRoot
} from './sourceTools'
import { runTool, type ToolContext, TOOLS } from './tools'

describe('Tess source tools', function () {
  this.timeout(20000)
  let temp: string
  let root: string
  let browser: ReturnType<typeof sourceBrowser>
  type Result = Awaited<ReturnType<typeof browser.run>>
  const read = async (path: string, startLine?: number): Promise<Result> =>
    await browser.run('source_read_file', { path, startLine })
  const unlock = async (): Promise<Result> => {
    const result = await read(DIRECTORY_MAP)
    expect(result.is_error).not.equals(true)
    browser.acceptMapResult(result)
    return result
  }
  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'tess-source-'))
    root = join(temp, 'src')
    await mkdir(join(root, 'feature'), { recursive: true })
    await writeFile(
      join(root, 'DIRECTORY_MAP.md'),
      '# Source map\nRead src/feature/example.ts\n'
    )
    await writeFile(
      join(root, 'feature/example.ts'),
      'export const limit = 10\n// literal .* [a] $(touch forbidden)\n'
    )
    await writeFile(join(temp, 'outside.txt'), 'OUTSIDE_ONLY')
    browser = sourceBrowser(root)
  })
  afterEach(async () => {
    await rm(temp, { recursive: true, force: true })
  })

  it('lists, reads numbered lines and searches literal text after the map', async () => {
    for (const name of [
      'source_read_file',
      'source_list_directory',
      'source_search'
    ] as const)
      expect(
        await browser.run(name, {
          path: 'src/feature/example.ts',
          text: 'limit'
        })
      ).deep.equals({ content: MAP_FIRST, is_error: true })
    expect((await unlock()).content).includes('1: # Source map')
    expect(
      (await browser.run('source_list_directory', { path: 'src/' })).content
    ).equals('src/DIRECTORY_MAP.md\nsrc/feature/')
    expect((await read('src/./feature/example.ts', 2)).content).includes(
      '2: // literal'
    )
    for (const text of ['.* [a]', '$(touch forbidden)']) {
      const result = await browser.run('source_search', {
        path: 'src/feature',
        text
      })
      expect(result.content).includes('src/feature/example.ts:2:')
      expect(result.is_error).not.equals(true)
    }
    expect(
      (
        await browser.run('source_search', {
          path: 'src/feature/example.ts',
          text: 'limit'
        })
      ).content
    ).includes(':1: export const limit = 10')
    expect(isSourceTool('source_read_file')).equals(true)
    expect(isSourceTool('shell')).equals(false)
    expect(SOURCE_TOOLS.map(t => t.name)).deep.equals([
      'source_list_directory',
      'source_read_file',
      'source_search'
    ])
    expect(TOOLS).includes.members(SOURCE_TOOLS)
    expect(
      (await readFile(join(root, 'feature/example.ts'), 'utf8')).startsWith(
        'export const limit'
      )
    ).equals(true)
  })

  it('unlocks only when the complete map survives fitting for the next request', async () => {
    browser.acceptMapResult({ content: 'not a map' })
    const result = await read(DIRECTORY_MAP)
    expect((await read('src/feature/example.ts')).content).equals(MAP_FIRST)
    browser.acceptMapResult({ content: result.content, is_error: true })
    browser.acceptMapResult({ content: 'Result removed for size.' })
    expect((await read('src/feature/example.ts')).content).equals(MAP_FIRST)
    browser.acceptMapResult(result)
    expect((await read('src/feature/example.ts')).is_error).not.equals(true)
  })

  it('handles empty files, empty directories, no matches and lines past EOF', async () => {
    await unlock()
    await writeFile(join(root, 'empty'), '')
    await mkdir(join(root, 'emptyDir'))
    expect((await read('src/empty')).content).includes(
      '(0 lines)\n[End of file.]'
    )
    expect((await read('src/feature/example.ts', 100)).content).includes(
      '[End of file.]'
    )
    expect(
      (await browser.run('source_list_directory', { path: 'src/emptyDir' }))
        .content
    ).equals('[Empty directory.]')
    expect(
      (
        await browser.run('source_search', {
          path: 'src',
          text: 'absent string'
        })
      ).content
    ).includes('[No matches.]')
  })

  it('does not share the map-read state or unlock on failed or partial map reads', async () => {
    await unlock()
    browser = sourceBrowser(root)
    expect((await read('src/feature/example.ts')).is_error).equals(true)
    await rm(join(root, 'DIRECTORY_MAP.md'))
    expect((await read(DIRECTORY_MAP)).is_error).equals(true)
    expect((await read('src/feature/example.ts')).content).equals(MAP_FIRST)
    await writeFile(join(root, 'DIRECTORY_MAP.md'), 'line\n'.repeat(201))
    expect((await read(DIRECTORY_MAP)).content).includes('startLine 201')
    expect((await read('src/feature/example.ts')).content).equals(MAP_FIRST)
    await read(DIRECTORY_MAP, 201)
    expect((await read('src/feature/example.ts')).content).equals(MAP_FIRST)
    await writeFile(join(root, 'DIRECTORY_MAP.md'), 'x'.repeat(22000))
    expect((await read(DIRECTORY_MAP)).content).includes('line is clipped')
    expect((await read('src/feature/example.ts')).content).equals(MAP_FIRST)
    await writeFile(join(root, 'DIRECTORY_MAP.md'), 'Map')
    await unlock()
    expect((await read('src/feature/example.ts')).is_error).not.equals(true)
  })

  it('rejects invalid arguments and out-of-bound paths without exposing local paths', async () => {
    for (const input of [
      null,
      [],
      'src',
      42,
      {},
      { path: 1 },
      { path: 'x'.repeat(4097) }
    ])
      expect((await browser.run('source_read_file', input)).is_error).equals(
        true
      )
    await unlock()
    for (const path of [
      '../outside.txt',
      'src/../outside.txt',
      'src/feature/../../outside.txt',
      'srcSibling/outside.txt',
      '/src/feature/example.ts',
      join(temp, 'outside.txt'),
      'src\\..\\outside.txt',
      'src/\0file',
      '.git/config',
      'package.json',
      'src/missing'
    ]) {
      for (const name of [
        'source_read_file',
        'source_list_directory',
        'source_search'
      ] as const) {
        const result = await browser.run(name, { path, text: 'OUTSIDE_ONLY' })
        expect(result.is_error, `${name} ${path}`).equals(true)
        expect(result.content).not.includes(temp)
        expect(result.content).not.includes('OUTSIDE_ONLY')
      }
    }
    for (const startLine of [
      0,
      -1,
      1.5,
      '1',
      Infinity,
      Number.MAX_SAFE_INTEGER + 1
    ])
      expect(
        (
          await browser.run('source_read_file', {
            path: DIRECTORY_MAP,
            startLine
          })
        ).is_error
      ).equals(true)
    for (const text of [
      undefined,
      '',
      1,
      'x'.repeat(501),
      'limit\n//',
      'limit\r//'
    ])
      expect(
        (await browser.run('source_search', { path: 'src', text })).is_error
      ).equals(true)
    const multiline = await browser.run('source_search', {
      path: 'src/feature/example.ts',
      text: 'export const limit = 10\n// literal'
    })
    expect(multiline.is_error).equals(true)
    expect(multiline.content).includes('one line')
    expect(multiline.content).not.includes('[No matches.]')
  })

  it('refuses symlink paths and skips links and loops during traversal', async () => {
    await symlink(join(temp, 'outside.txt'), join(root, 'outside-link'))
    await symlink(join(root, 'feature'), join(root, 'inside-link'))
    await symlink(root, join(root, 'feature/loop'))
    await symlink(join(temp, 'missing'), join(root, 'dangling'))
    await unlock()
    for (const path of [
      'src/outside-link',
      'src/inside-link/example.ts',
      'src/feature/loop/DIRECTORY_MAP.md',
      'src/dangling'
    ])
      expect((await read(path)).is_error, path).equals(true)
    const listed = (await browser.run('source_list_directory', { path: 'src' }))
      .content
    expect(listed).not.match(/outside-link|inside-link|dangling/)
    const searched = await browser.run('source_search', {
      path: 'src',
      text: 'OUTSIDE_ONLY'
    })
    expect(searched.content).includes('[No matches.]')
    expect(searched.is_error).not.equals(true)
    await symlink(root, join(temp, 'linked-src'))
    expect(
      (
        await sourceBrowser(join(temp, 'linked-src')).run('source_read_file', {
          path: DIRECTORY_MAP
        })
      ).is_error
    ).equals(true)
    expect(
      (
        await sourceBrowser(join(temp, 'absent')).run('source_read_file', {
          path: DIRECTORY_MAP
        })
      ).is_error
    ).equals(true)
  })

  it('refuses directories as files, files as directories, binary/invalid UTF-8 and oversized files', async () => {
    await unlock()
    await writeFile(join(root, 'binary'), Buffer.from([1, 0, 2]))
    await writeFile(join(root, 'invalid'), Buffer.from([0xff, 0xfe]))
    await writeFile(
      join(root, 'large'),
      Buffer.alloc(SOURCE_LIMITS.fileBytes + 1, 65)
    )
    for (const path of [
      'src/feature',
      'src/binary',
      'src/invalid',
      'src/large'
    ])
      expect((await read(path)).is_error).equals(true)
    expect(
      (await browser.run('source_list_directory', { path: 'src/binary' }))
        .is_error
    ).equals(true)
    const result = await browser.run('source_search', {
      path: 'src',
      text: 'export const limit'
    })
    expect(result.content).includes('example.ts:1:')
    expect(result.content).includes('[3 files skipped.]')
  })

  it('caps reads and paginates lines', async () => {
    await unlock()
    await writeFile(
      join(root, 'many'),
      Array.from({ length: 220 }, (_, i) => `row ${i + 1}`).join('\n')
    )
    expect((await read('src/many')).content).includes('startLine 201')
    expect((await read('src/many', 201)).content).includes('220: row 220')
    await writeFile(join(root, 'wide'), 'X'.repeat(30000))
    const wide = await read('src/wide')
    expect(wide.content.length).at.most(SOURCE_LIMITS.outputCharacters)
    expect(wide.content).includes('line is clipped')
  })

  it('caps listing, search matches and search output', async () => {
    await unlock()
    await Promise.all(
      Array.from({ length: 205 }, async (_, i) => {
        await writeFile(join(root, 'feature', `file-${i}.ts`), 'match\n')
      })
    )
    expect(
      (await browser.run('source_list_directory', { path: 'src/feature' }))
        .content
    ).includes('[Listing limited.]')
    expect(
      (
        await browser.run('source_search', {
          path: 'src/feature',
          text: 'match'
        })
      ).content
    ).includes('[Search limited;')
    await writeFile(
      join(root, 'wide'),
      ('match' + 'X'.repeat(1000) + '\n').repeat(49)
    )
    const result = await browser.run('source_search', {
      path: 'src/wide',
      text: 'match'
    })
    expect(result.content.length).at.most(SOURCE_LIMITS.outputCharacters)
    expect(result.content).includes('[line clipped]')
    expect(result.content).includes('[Search limited;')
    await writeFile(join(root, 'late-match'), 'X'.repeat(2000) + 'needle')
    expect(
      (
        await browser.run('source_search', {
          path: 'src/late-match',
          text: 'needle'
        })
      ).content
    ).includes('needle')
  })

  it('caps scanned bytes and visited entries even when nothing matches', async () => {
    await unlock()
    await mkdir(join(root, 'bytes'))
    await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        await writeFile(
          join(root, 'bytes', String(i)),
          Buffer.alloc(SOURCE_LIMITS.fileBytes, 65)
        )
      })
    )
    expect(
      (
        await browser.run('source_search', {
          path: 'src/bytes',
          text: 'no match'
        })
      ).content
    ).includes('[Search limited;')
    await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        await writeFile(
          join(root, 'bytes', String(i)),
          Buffer.alloc(SOURCE_LIMITS.fileBytes)
        )
      })
    )
    expect(
      (
        await browser.run('source_search', {
          path: 'src/bytes',
          text: 'no match'
        })
      ).content
    ).includes('[Search limited;')
    await mkdir(join(root, 'entries'))
    await Promise.all(
      Array.from({ length: SOURCE_LIMITS.visitedEntries + 1 }, async (_, i) => {
        await symlink('../missing', join(root, 'entries', String(i)))
      })
    )
    expect(
      (
        await browser.run('source_search', {
          path: 'src/entries',
          text: 'no match'
        })
      ).content
    ).includes('[Search limited;')
  })

  it('dispatches source tools without user-role checks and fails safely outside a turn', async () => {
    const context: ToolContext = {
      source: browser,
      db: undefined as unknown as ToolContext['db'],
      userId: 'usr_example',
      credentials: {},
      origin: 'http://example.test',
      now: new Date(),
      proposals: { count: 0 }
    }
    const call = {
      type: 'tool_use' as const,
      id: 'source-map',
      name: 'source_read_file',
      input: { path: DIRECTORY_MAP }
    }
    const result = await runTool(context, call)
    expect(result.result.content).includes('# Source map')
    expect(result.result.tool_use_id).equals('source-map')
    expect(result.changeId).equals(undefined)
    expect(
      (await runTool({ ...context, source: undefined }, call)).result.is_error
    ).equals(true)
    expect(
      (await runTool(context, { ...call, name: 'run_shell' })).result.is_error
    ).equals(true)
  })

  it('locates the same src from TypeScript and compiled server modules and checks the real map', async () => {
    expect(sourceRoot(resolve('src/server/tess'))).equals(resolve('src'))
    expect(sourceRoot(resolve('lib/server/tess'))).equals(resolve('src'))
    const result = await sourceBrowser().run('source_read_file', {
      path: DIRECTORY_MAP
    })
    expect(result.is_error).not.equals(true)
    expect(result.content).not.match(/Output limited|More lines/)
    const map = await readFile(join(sourceRoot(), 'DIRECTORY_MAP.md'), 'utf8')
    for (const match of map.matchAll(/`(src\/[^`]+)`/g))
      await import('node:fs/promises').then(async fs => {
        await fs.access(resolve(match[1]))
      })
    expect(map).includes('src/server/tess/sourceTools.ts')
  })
})
