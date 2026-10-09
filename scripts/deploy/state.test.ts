import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import path from 'node:path'

import { afterEach, beforeEach, describe, it } from 'mocha'

import { app, testRoot } from './config.test'
import { childEnvironment, DeploymentToolError, Processes } from './process'
import {
  asRun,
  atomicJson,
  createOutput,
  noSymlinks,
  ownedDirectory,
  runId,
  State
} from './state'
let root: string
const id = 'a'.repeat(32)
const record = (): ReturnType<typeof asRun> =>
  asRun({
    id,
    app,
    branch: 'master',
    commit: 'a'.repeat(40),
    createdAt: Date.now(),
    version: '1.2.3',
    platforms: ['ios'],
    artifacts: [],
    failed: []
  })
describe('Deployment state and owned processes', () => {
  beforeEach(() => {
    root = testRoot('state-')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })
  it('reserves monotonically across restart, holds an OS lock and never recycles failures', () => {
    const directory = path.join(root, 'state')
    let state = new State(directory)
    assert.throws(() => new State(directory), /Another deployment/)
    assert.equal(state.reserve(app, 'ios', 42), 42)
    assert.equal(state.reserve(app, 'ios', 1), 43)
    assert.equal(state.reserve(app, 'android', 1), 1)
    state.save(record())
    assert.equal(state.load(id).id, id)
    state.close()
    state = new State(directory)
    assert.equal(state.reserve(app, 'ios', 42), 44)
    assert.equal(state.reserve(app, 'ios', 100), 100)
    state.db
      .prepare('UPDATE counters SET value=? WHERE platform=?')
      .run(2100000000, 'ios')
    assert.throws(() => state.reserve(app, 'ios', 1))
    assert.throws(() => state.load('missing'))
    assert.throws(() =>
      state.save({
        ...record(),
        artifacts: [
          {
            platform: 'ios',
            file: '../bad.ipa',
            size: 1,
            digest: 'a'.repeat(64),
            version: '1',
            buildNumber: 1
          }
        ]
      })
    )
    state.close()
    // A separate process exits without closing: SQLite releases its process-held lock.
    execFileSync(
      process.execPath,
      [
        '-r',
        'sucrase/register',
        '-e',
        'const {State}=require("./scripts/deploy/state"); new State(process.argv[1]); process.exit(0)',
        directory
      ],
      { stdio: 'pipe' }
    )
    new State(directory).close()
  })
  it('prunes only expired marked outputs and retains records for fourteen days', () => {
    const state = new State(path.join(root, 'state'))
    const output = path.join(root, 'output')
    const directory = createOutput(output, id)
    const run = record()
    state.save(run)
    writeFileSync(path.join(directory, 'fixture.ipa'), 'fixture')
    state.prune(output, run.createdAt + 47 * 3600000)
    assert(existsSync(directory))
    state.prune(output, run.createdAt + 49 * 3600000)
    assert(!existsSync(directory))
    assert.equal(state.load(id).id, id)
    state.prune(output, run.createdAt + 15 * 86400000)
    assert.throws(() => state.load(id))
    const next = createOutput(output, id)
    state.save(run)
    writeFileSync(
      path.join(next, '.run'),
      JSON.stringify({ id: 'b'.repeat(32) })
    )
    assert.throws(() => {
      state.prune(output, run.createdAt + 49 * 3600000)
    })
    state.close()
  })
  it('refuses symlink escapes, unsafe identities and foreign directory markers', () => {
    const directory = ownedDirectory(path.join(root, 'owned'), 'test')
    assert.equal(ownedDirectory(directory, 'test'), directory)
    assert.throws(() => ownedDirectory(directory, 'other'))
    symlinkSync(path.join(root, 'missing'), path.join(root, 'dangling'))
    assert.throws(() => {
      noSymlinks(path.join(root, 'dangling'))
    })
    symlinkSync(directory, path.join(root, 'link'))
    assert.throws(() => new State(path.join(root, 'link')))
    assert.throws(() => runId('bad'))
    assert.throws(() =>
      asRun({
        ...record(),
        artifacts: [
          {
            platform: 'ios',
            file: 'a',
            digest: 'bad',
            size: 1,
            version: '1',
            buildNumber: 1
          }
        ]
      })
    )
    const file = path.join(root, 'state.json')
    atomicJson(file, { version: 1 })
    atomicJson(file, { version: 2 })
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 2 })
    assert.throws(() => {
      atomicJson(path.join(root, 'link'), {})
    })
    mkdirSync(path.join(root, 'bad'))
    writeFileSync(
      path.join(root, 'bad', '.teamstation-deploy'),
      '{"version":1,"kind":"state"}'
    )
    mkdirSync(path.join(root, 'bad', 'numbers.sqlite'))
    assert.throws(() => new State(path.join(root, 'bad')))
  })
  it('allows only selected child environment, suppresses secret output and cancels owned process groups', async () => {
    process.env.DEPLOY_SECRET_FIXTURE = 'synthetic-secret'
    assert.equal(childEnvironment().DEPLOY_SECRET_FIXTURE, undefined)
    assert.equal(childEnvironment({ EXPLICIT: 'fixture' }).EXPLICIT, 'fixture')
    delete process.env.DEPLOY_SECRET_FIXTURE
    const cancel = new AbortController()
    const processGroup = new Processes(cancel.signal)
    assert.equal(
      await processGroup.run({
        file: process.execPath,
        args: ['-e', 'process.stdin.pipe(process.stdout)'],
        cwd: root,
        input: 'fixture'
      }),
      'fixture'
    )
    await assert.rejects(
      processGroup.run({
        file: 'missing-deployment-tool',
        args: [],
        cwd: root
      }),
      /Could not start/
    )
    await assert.rejects(
      processGroup.run({
        file: process.execPath,
        args: ['-e', 'console.error("synthetic-secret");process.exit(1)'],
        cwd: root
      }),
      (error: unknown) => {
        assert(error instanceof DeploymentToolError)
        assert.equal(error.tool, path.basename(process.execPath))
        assert.equal(error.exitCode, 1)
        assert.equal(error.message, 'Deployment tool failed')
        assert(!JSON.stringify(error).includes('synthetic-secret'))
        return true
      }
    )
    await assert.rejects(
      processGroup.run({
        file: process.execPath,
        args: ['-e', 'process.kill(process.pid, "SIGTERM")'],
        cwd: root
      }),
      (error: unknown) => {
        assert(error instanceof DeploymentToolError)
        assert.equal(error.signal, 'SIGTERM')
        assert.equal(error.exitCode, undefined)
        assert.equal(error.message, 'Deployment tool failed')
        return true
      }
    )
    await assert.rejects(
      processGroup.run({
        file: process.execPath,
        args: ['-e', 'process.stdout.write("x".repeat(1048577))'],
        cwd: root
      }),
      /exceeded limit/
    )
    const stop = await processGroup.inhibit(process.execPath, root)
    stop()
    const task = processGroup.run({
      file: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: root
    })
    setTimeout(() => {
      cancel.abort()
    }, 30)
    await assert.rejects(task, /cancelled/)
    await assert.rejects(
      processGroup.run({ file: process.execPath, args: [], cwd: root })
    )
    await assert.rejects(processGroup.inhibit(process.execPath, root))
  })
})
