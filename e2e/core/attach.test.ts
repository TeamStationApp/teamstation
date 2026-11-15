import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'

import {
  attachStack,
  checkLocalStackId,
  checkStackId,
  listStacks,
  newStackId,
  parseHandle,
  projectKey,
  readStack,
  refuseAttachedForFaults,
  removeStack,
  stackHandleFor
} from './attach'
import { BlockedError, HarnessError } from './result'

const HANDLE = {
  version: 1,
  id: 'streamtest-202611121400',
  origin: 'https://streamtest.example.test/',
  api: 'https://streamtest.example.test/api/v1',
  ssh: 'stack@streamtest.example.test',
  serverLog: '/var/log/teamstation/api.log'
}

function scratch(): { dir: string; handle: (value: unknown) => string } {
  const root = mkdtempSync(join(tmpdir(), 'e2e-attach-'))
  let n = 0
  return {
    dir: join(root, 'stacks'),
    handle: value => {
      const file = join(root, `handle${n++}.json`)
      writeFileSync(
        file,
        typeof value === 'string' ? value : JSON.stringify(value)
      )
      return file
    }
  }
}

function thrown(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a throw')
}

describe('attached stacks', function () {
  it('registers a handle under its id, then lists it with its origin', function () {
    const { dir, handle } = scratch()
    const file = handle(HANDLE)
    const entry = attachStack(dir, file)
    expect(entry.id).equals(HANDLE.id)
    expect(entry.origin).equals('https://streamtest.example.test')
    expect(entry.handleFile).equals(file)
    expect(listStacks(dir).map(row => row.id)).deep.equals([HANDLE.id])
    expect(readStack(dir, HANDLE.id).handle?.serverLog).equals(HANDLE.serverLog)
    // Its database URL is in the entry: only this user may read it.
    expect(statSync(dir).mode & 0o777).equals(0o700)
    expect(statSync(join(dir, `${HANDLE.id}.json`)).mode & 0o777).equals(0o600)
  })

  it('keeps fields a later handle version adds, and re-attaching replaces it', function () {
    const { dir, handle } = scratch()
    attachStack(dir, handle(HANDLE))
    attachStack(dir, handle({ ...HANDLE, version: 2, bucket: 'stream-b' }))
    const entry = readStack(dir, HANDLE.id)
    expect(entry.handle?.version).equals(2)
    expect(entry.handle?.bucket).equals('stream-b')
    expect(listStacks(dir)).has.length(1)
  })

  it('gives a scenario the attached origin, with no proxy and no error feed', async function () {
    const { dir, handle } = scratch()
    const stack = stackHandleFor(attachStack(dir, handle(HANDLE)))
    expect(stack.kind).equals('isolated')
    expect(stack.origin).equals('https://streamtest.example.test')
    expect(stack.attached?.api).equals(HANDLE.api)
    expect(await stack.adopt('http://elsewhere.test')).equals(
      'http://elsewhere.test'
    )
    expect(await stack.serverErrors(0)).equals(undefined)
  })

  it('gives a stack up stack its baseline, fixtures and logged 5xx', async function () {
    const { dir } = scratch()
    const errorLog = join(dir, '..', 'up.errors.jsonl')
    writeFileSync(
      errorLog,
      [
        { at: 1, method: 'GET', path: '/api/v1/old', status: 500 },
        { at: 5, method: 'POST', path: '/api/v1/new', status: 503 }
      ]
        .map(row => JSON.stringify(row))
        .join('\n') + '\n'
    )
    const entry = {
      id: 'up',
      origin: 'http://127.0.0.1:1',
      pid: 1,
      dir: join(dir, 'up'),
      root: '/checkout',
      baselineManifest: join(dir, 'up', 'baseline.json'),
      errorLog
    }
    const stack = stackHandleFor(entry)
    expect(stack.baselineManifest).equals(entry.baselineManifest)
    expect((await stack.serverErrors(2))?.map(row => row.path)).deep.equals([
      '/api/v1/new'
    ])
    let failure: unknown
    await stack.seedWorld?.('team-with-roster').catch((error: unknown) => {
      failure = error
    })
    expect(failure).instanceOf(BlockedError)
    expect(String(failure)).includes('no test mailbox')
    expect(
      await stackHandleFor({
        ...entry,
        errorLog: join(dir, 'none')
      }).serverErrors(0)
    ).deep.equals([])
  })

  it('names a stack for its project and six random hex digits', function () {
    const id = newStackId('streamingFixes')
    expect(id).matches(/^streamingFixes_[0-9a-f]{6}$/)
    expect(newStackId('streamingFixes')).not.equals(id)
    expect(checkLocalStackId(id)).equals(id)
    expect(projectKey('paul-stream.fixes')).equals('paulstreamfixes')
    expect(projectKey('2026plan')).equals('stack2026plan')
    for (const bad of [
      'streamingFixes',
      'streamingFixes_1EF39D',
      'stream-1a',
      'a_1ef39'
    ]) {
      expect(
        thrown(() => checkLocalStackId(bad)),
        bad
      ).instanceOf(HarnessError)
    }
  })

  it('refuses a stack id that could leave the registry or change case in Postgres', function () {
    const { dir } = scratch()
    expect(checkStackId('stream-1a')).equals('stream-1a')
    for (const id of ['MyStack', '../etc', 'a/b', '-lead', '']) {
      expect(thrown(() => checkStackId(id))).instanceOf(HarnessError)
    }
    expect(thrown(() => readStack(dir, '../escape'))).instanceOf(HarnessError)
  })

  it('refuses fault runs on an attached stack as blocked, not on one it started', function () {
    const { dir, handle } = scratch()
    const entry = attachStack(dir, handle(HANDLE))
    expect(
      thrown(() => {
        refuseAttachedForFaults(entry)
      })
    ).instanceOf(BlockedError)
    expect(() => {
      refuseAttachedForFaults({ id: 'up', origin: 'http://x.test', pid: 1 })
    }).not.to.throw()
  })

  it('forgets an attached stack without stopping anything, and stops a started one', function () {
    const { dir, handle } = scratch()
    attachStack(dir, handle(HANDLE))
    const killed: number[] = []
    const kill = (pid: number): boolean => {
      killed.push(pid)
      return true
    }
    expect(removeStack(dir, HANDLE.id, kill)).deep.equals({
      id: HANDLE.id,
      stopped: false
    })
    writeFileSync(
      join(dir, 'up.json'),
      JSON.stringify({ id: 'up', origin: 'http://x.test', pid: 4242 })
    )
    expect(removeStack(dir, 'up', kill).stopped).equals(true)
    expect(killed).deep.equals([4242])
    // One whose stack serve is already gone is forgotten all the same.
    writeFileSync(
      join(dir, 'gone.json'),
      JSON.stringify({ id: 'gone', origin: 'http://x.test', pid: 4243 })
    )
    expect(removeStack(dir, 'gone', () => false)).deep.equals({
      id: 'gone',
      stopped: false
    })
    expect(listStacks(dir)).deep.equals([])
  })

  it('will not attach over a stack that stack up is running', function () {
    const { dir, handle } = scratch()
    attachStack(dir, handle({ ...HANDLE, id: 'other' }))
    writeFileSync(
      join(dir, `${HANDLE.id}.json`),
      JSON.stringify({ id: HANDLE.id, origin: 'http://x.test', pid: 1 })
    )
    expect(thrown(() => attachStack(dir, handle(HANDLE))).message).includes(
      'running stack up stack'
    )
    expect(
      JSON.parse(readFileSync(join(dir, `${HANDLE.id}.json`), 'utf8')).pid
    ).equals(1)
  })

  it('calls a malformed or missing handle a harness error', function () {
    const { dir, handle } = scratch()
    const cases: Array<[unknown, string]> = [
      ['{not json', 'not JSON'],
      [[1], 'not a stack handle object'],
      [{ ...HANDLE, version: undefined }, 'no handle version'],
      [{ ...HANDLE, id: 'Has Spaces' }, 'no stack id'],
      [{ ...HANDLE, origin: 'streamtest.example.test' }, 'no origin URL'],
      [{ ...HANDLE, api: 7 }, 'no api URL']
    ]
    for (const [value, message] of cases) {
      const error = thrown(() => attachStack(dir, handle(value)))
      expect(error, message).instanceOf(HarnessError)
      expect(error.message).includes(message)
    }
    expect(thrown(() => attachStack(dir, join(dir, 'absent.json')))).instanceOf(
      HarnessError
    )
    expect(
      parseHandle(JSON.stringify({ ...HANDLE, api: undefined }), 'h').api
    ).equals(undefined)
    expect(thrown(() => readStack(dir, 'absent')).message).includes(
      'No stack "absent"'
    )
  })
})
