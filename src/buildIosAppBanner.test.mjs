import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { mock, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import * as esbuild from 'esbuild'

import {
  compiledCoverageSource,
  localCoverageMap,
  requireCounters,
  requiredLines
} from '../scripts/ios-app-banner-reports.mjs'

// Exercise the build entry point in both modes using tiny inputs for the
// unrelated WASM, workers and app. The banner compiler and HTML are real.
test('both build modes put a runnable banner script at the end of the head', async () => {
  const base = path.resolve('coverage/ios-app-banner/unit-build')
  await mkdir(base, { recursive: true })
  const input = path.join(base, 'fixture.js')
  await writeFile(input, 'void 0')
  mock.module('../scripts/chatCryptoBuild.mjs', {
    namedExports: {
      findCargo: () => ({}),
      buildWasm: () => input
    }
  })
  mock.module('../scripts/schedulerBuild.mjs', {
    namedExports: {
      buildWasm: () => ({ wasm: input, glue: input })
    }
  })
  mock.module('../scripts/serviceWorkerBuild.mjs', {
    namedExports: { buildServiceWorker: async () => {} }
  })
  let failAppBuild = false
  const watched = []
  const bannerBuilds = []
  mock.module('esbuild', {
    namedExports: {
      build: async options => {
        if (options.entryPoints?.[0] === 'src/app/web/iosAppBanner.ts') {
          bannerBuilds.push(options)
          return await esbuild.build(options)
        }
        if (failAppBuild && options.entryNames === 'app-[hash]')
          throw new Error('app build failed')
        return await esbuild.build({ ...options, entryPoints: [input] })
      },
      context: async options => ({
        rebuild: async () => {
          assert.equal(options.entryPoints[0], 'src/app/web/iosAppBanner.ts')
          bannerBuilds.push(options)
          return await esbuild.build(options)
        },
        watch: async () => watched.push(options),
        serve: async () => ({ hosts: ['localhost'], port: 8080 })
      })
    }
  })
  const savedArgs = process.argv
  const savedEnv = process.env
  try {
    for (const serve of [false, true]) {
      const out = path.join(base, serve ? 'dev' : 'release')
      await mkdir(out, { recursive: true })
      await writeFile(path.join(out, 'ios-app-banner-STALE123.js'), 'old')
      const api = serve ? 'https://dev.example.test/api/v1' : '/api/v1'
      process.env = { ...savedEnv, TS_WEB_OUT_DIR: out, TS_API_BASE_URL: api }
      process.argv = [
        process.execPath,
        'src/build.mjs',
        ...(serve ? ['--serve'] : [])
      ]
      bannerBuilds.length = 0
      await import('./build.mjs?mode=' + (serve ? 'dev' : 'release'))
      // Serving builds the banner once, through its watcher.
      assert.equal(bannerBuilds.length, 1)
      const bannerWatchers = watched.filter(
        options => options.entryPoints[0] === 'src/app/web/iosAppBanner.ts'
      )
      assert.equal(bannerWatchers.length, serve ? 1 : 0)
      if (serve) {
        const [options] = bannerWatchers
        assert.equal(options.outdir, out)
        assert.equal(options.entryNames, 'ios-app-banner')
        assert.equal(options.define.TS_API_BASE_URL, JSON.stringify(api))
      }
      const html = await readFile(path.join(out, 'index.html'), 'utf8')
      const tags = [
        ...html.matchAll(
          /<script src="\/((?:app-)?ios-app-banner[^"]*)"([^>]*)><\/script>/gi
        )
      ]
      assert.equal(tags.length, 1)
      const [tag] = tags
      assert(
        tag.index > html.indexOf('Content-Security-Policy') &&
          tag.index > html.indexOf('</style>') &&
          tag.index < html.indexOf('</head>')
      )
      assert.match(
        tag[1],
        serve ? /^ios-app-banner\.js$/ : /^app-ios-app-banner-[A-Z0-9]+\.js$/
      )
      assert(
        serve ? tag[2] === '' : /^ integrity="sha384-[\w+/=]+"$/.test(tag[2])
      )
      const written = []
      const window = {}
      window.top = window
      const context = vm.createContext({
        window,
        setTimeout,
        clearTimeout,
        getComputedStyle: () => ({ getPropertyValue: () => '12345' }),
        document: {
          readyState: 'loading',
          querySelector: () => null,
          write: tag => written.push(tag)
        },
        navigator: {
          platform: 'iPad',
          userAgent: 'iPad Version/18.0 Mobile/15E Safari/604'
        }
      })
      vm.runInContext(await readFile(path.join(out, tag[1]), 'utf8'), context)
      const finish = /<script>([^<]+)<\/script>/i.exec(html)[1]
      vm.runInContext(finish, context)
      assert.deepEqual(written, [
        `<link rel="stylesheet" id="teamstation-ios-app-banner-css" href="${api}/node/ios-app-banner">`,
        '<meta name="apple-itunes-app" content="app-id=12345">'
      ])
      if (!serve) {
        const publishedScripts = [
          ...html.matchAll(/<script src="\/([^"]+)" /gi)
        ]
        const files = await Promise.all(
          publishedScripts.map(match => readFile(path.join(out, match[1])))
        )
        assert.equal(files.length, 2)
        process.env.TS_API_BASE_URL = '/changed/api'
        failAppBuild = true
        await assert.rejects(import('./build.mjs?failed'), /app build failed/)
        failAppBuild = false
        assert.equal(await readFile(path.join(out, 'index.html'), 'utf8'), html)
        for (const [i, match] of publishedScripts.entries())
          assert.deepEqual(await readFile(path.join(out, match[1])), files[i])
        await import('./build.mjs?replacement')
        const replacement = await readFile(path.join(out, 'index.html'), 'utf8')
        assert(!replacement.includes(tag[1]))
        await assert.rejects(readFile(path.join(out, tag[1])), {
          code: 'ENOENT'
        })
      }
    }
  } finally {
    process.env = savedEnv
    process.argv = savedArgs
    mock.restoreAll()
  }
})

function fixtureGitEnv() {
  const env = { ...process.env }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'])
    delete env[key]
  return env
}

test('coverage stamps require a fresh directory and include changes to tests', async () => {
  const root = path.resolve('coverage/ios-app-banner')
  await mkdir(root, { recursive: true })
  const cwd = await mkdtemp(path.join(root, 'stamp-check-'))
  const script = fileURLToPath(
    new URL('../scripts/ios-app-banner-coverage.mjs', import.meta.url)
  )
  const env = fixtureGitEnv()
  const stamp = directory =>
    spawnSync(process.execPath, [script, 'stamp'], {
      cwd,
      encoding: 'utf8',
      env: {
        ...env,
        NODE_V8_COVERAGE: path.join(cwd, 'coverage', directory)
      }
    })
  const git = (...args) => execFileSync('git', args, { cwd, env })
  await writeFile(path.join(cwd, '.gitignore'), 'coverage/\n')
  await writeFile(path.join(cwd, 'banner.test.ts'), 'export {}')
  git('init', '-q')
  git('add', '.gitignore', 'banner.test.ts')
  const stale = path.join(cwd, 'coverage', 'old')
  await mkdir(stale, { recursive: true })
  await writeFile(path.join(stale, 'coverage-old.json'), '{}')
  assert.match(stamp('old').stderr, /fresh coverage directory/)
  assert.equal(stamp('current').status, 0)
  assert.equal(stamp('current').status, 0)
  await writeFile(path.join(cwd, 'banner.test.ts'), 'export const test = 1')
  assert.match(stamp('current').stderr, /Stage all source changes/)
  git('add', 'banner.test.ts')
  assert.match(stamp('current').stderr, /fresh coverage directory/)
})

test('an independent upstream commit preserves the feature coverage base', async () => {
  const root = path.resolve('coverage/ios-app-banner')
  await mkdir(root, { recursive: true })
  const cwd = await mkdtemp(path.join(root, 'base-check-'))
  const options = {
    cwd,
    env: { ...fixtureGitEnv(), TS_COVERAGE_BASE: '' },
    encoding: 'utf8'
  }
  const module = fileURLToPath(
    new URL('../scripts/ios-app-banner-source.cjs', import.meta.url)
  )
  const coverageBase = () =>
    execFileSync(
      process.execPath,
      ['-p', 'require(process.argv[1]).coverageBase()', module],
      options
    ).trim()
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        ...args
      ],
      options
    ).trim()
  git('init', '-q', '-b', 'feature')
  git('commit', '-q', '--allow-empty', '-m', 'base')
  const base = git('rev-parse', 'HEAD')
  git('update-ref', 'refs/remotes/origin/develop', base)
  git('commit', '-q', '--allow-empty', '-m', 'feature')
  assert.equal(coverageBase(), base)
  git('switch', '-q', '--detach', base)
  git('commit', '-q', '--allow-empty', '-m', 'upstream')
  git('update-ref', 'refs/remotes/origin/develop', 'HEAD')
  git('switch', '-q', 'feature')
  assert.equal(coverageBase(), base)
  // A stacked branch names its own base.
  git('switch', '-q', '-c', 'stacked')
  const stackedBase = git('rev-parse', 'HEAD')
  git('commit', '-q', '--allow-empty', '-m', 'stacked')
  options.env = { ...options.env, TS_COVERAGE_BASE: 'feature' }
  assert.equal(coverageBase(), stackedBase)
  options.env = { ...options.env, TS_COVERAGE_BASE: '' }
  assert.equal(coverageBase(), base)
})

test('compiled server counters require a map embedding their current TypeScript source', async () => {
  const source = 'src/server/nodeSettings.ts'
  const name = '/fixture/lib/server/nodeSettings.js'
  const pathFor = url => (url.endsWith(source) ? source : undefined)
  const map = {
    lineLengths: [10],
    data: {
      version: 3,
      names: [],
      sources: [source],
      sourcesContent: [await readFile(source, 'utf8')],
      mappings: 'AAAA'
    }
  }
  assert.equal(compiledCoverageSource(name, map, pathFor), source)
  for (const invalid of [
    undefined,
    { ...map, lineLengths: [] },
    { ...map, data: { ...map.data, sources: ['src/server/other.ts'] } },
    { ...map, data: { ...map.data, mappings: 'A' } }
  ])
    assert.throws(
      () => compiledCoverageSource(name, invalid, pathFor),
      /Missing usable compiled source map/
    )
  for (const sourcesContent of [undefined, [null], ['export const stale = 1']])
    assert.throws(
      () =>
        compiledCoverageSource(
          name,
          { ...map, data: { ...map.data, sourcesContent } },
          pathFor
        ),
      /Missing or stale compiled source content/
    )
})

test('unit counters from another checkout merge into local integration counters', () => {
  const source = 'src/common/nodeSettings.ts'
  const pathFor = key => (key.endsWith(source) ? source : undefined)
  const file = path.resolve(source)
  const counter = (path, hits) => ({
    path,
    statementMap: {
      0: { start: { line: 1, column: 0 }, end: { line: 1, column: 8 } }
    },
    s: { 0: hits },
    fnMap: {},
    f: {},
    branchMap: {},
    b: {}
  })
  const remote = '/unit-checkout/' + source
  const unit = localCoverageMap({ [remote]: counter(remote, 4) }, pathFor)
  unit.merge({ [file]: counter(file, 2) })
  assert.deepEqual(unit.files(), [file])
  assert.equal(unit.fileCoverageFor(file).getLineCoverage()[1], 6)
})

test('a partially measured file fails before its percentage can pass', () => {
  const file = 'src/banner.ts'
  const source = [
    'declare const id: string',
    'type Id = string',
    '// Safari reads the meta tag while parsing.',
    'if (/^[0-9]+$/.test(id))',
    '  document.write(id)'
  ].join('\n')
  const required = requiredLines(file, source, [1, 2, 3, 4, 5])
  assert.deepEqual([...required], [4, 5])
  const location = line => ({
    start: { line, column: 0 },
    end: { line, column: 20 }
  })
  const entry = { statementMap: { 0: location(4) }, s: { 0: 1 } }
  const report = { [path.resolve(file)]: entry }
  assert.throws(
    () => requireCounters(report, file, required),
    /Missing measured counter for src\/banner\.ts:5/
  )
  entry.statementMap[1] = location(5)
  assert.throws(
    () => requireCounters(report, file, required),
    /Invalid statement counter/
  )
  entry.s[1] = 0
  requireCounters(report, file, required)
})
