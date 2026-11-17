import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'

import {
  attachStack,
  baselineFile,
  checkStackId,
  forgetStack,
  listStacks,
  parseHandle,
  readStack,
  stackHandleFor
} from './attach'
import { BlockedError, HarnessError } from './result'

const HANDLE = {
  version: 2,
  id: 'e2e-stack-20261112-140000',
  name: 'e2e-01',
  origin: 'https://e2e-01.example.test/',
  api: 'https://e2e-01.example.test/api/v1',
  ssh: 'observer@203.0.113.7',
  serverLog: '/srv/e2e/log/api.log',
  hlsRoot: '/srv/e2e/media/work/videos',
  databaseUrl:
    'postgres://u:p@e2e-01.example.test:5432/teamstation?sslmode=require'
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
    expect(entry.origin).equals('https://e2e-01.example.test')
    expect(entry.handleFile).equals(file)
    expect(listStacks(dir).map(row => row.id)).deep.equals([HANDLE.id])
    expect(readStack(dir, HANDLE.id).handle?.serverLog).equals(HANDLE.serverLog)
    // Its database URL is in the entry: only this user may read it.
    expect(statSync(dir).mode & 0o777).equals(0o700)
    expect(statSync(join(dir, `${HANDLE.id}.json`)).mode & 0o777).equals(0o600)
    // Written whole and renamed into place: no part is left beside it.
    expect(readdirSync(dir).filter(name => name.endsWith('.part'))).deep.equals(
      []
    )
  })

  it('keeps fields a later handle version adds, and re-attaching replaces it', function () {
    const { dir, handle } = scratch()
    attachStack(dir, handle(HANDLE))
    attachStack(dir, handle({ ...HANDLE, version: 3, bucket: 'stream-b' }))
    const entry = readStack(dir, HANDLE.id)
    expect(entry.handle?.version).equals(3)
    expect(entry.handle?.bucket).equals('stream-b')
    expect(listStacks(dir)).has.length(1)
  })

  it('gives a scenario the droplet’s origin, its seeding, and no fault control without a fault server', async function () {
    const { dir, handle } = scratch()
    const stack = stackHandleFor(attachStack(dir, handle(HANDLE)))
    expect(stack.kind).equals('isolated')
    expect(stack.origin).equals('https://e2e-01.example.test')
    expect(stack.attached?.api).equals(HANDLE.api)
    expect(await stack.adopt('http://elsewhere.test')).equals(
      'http://elsewhere.test'
    )
    expect(await stack.serverErrors(0)).equals(undefined)
    expect(stack.setFault).equals(undefined)
    // Seeding needs the test mailbox.
    let blocked: unknown
    await stack.seedWorld?.('team-with-roster').catch((error: unknown) => {
      blocked = error
    })
    expect(blocked).instanceOf(BlockedError)
    // With a fault server, it sets the fault through it.
    const faulted = stackHandleFor(
      attachStack(
        dir,
        handle({
          ...HANDLE,
          faults: { url: 'https://e2e-01.example.test/__e2e/', token: 't' }
        })
      )
    )
    expect(faulted.setFault).a('function')
  })

  it('refuses a handle older than a droplet stack’s', function () {
    const { dir, handle } = scratch()
    const old = attachStack(dir, handle({ ...HANDLE, version: 1 }))
    expect(thrown(() => stackHandleFor(old)).message).includes(
      'bring it up again with stack up'
    )
    const partial = attachStack(
      dir,
      handle({ ...HANDLE, databaseUrl: undefined })
    )
    expect(thrown(() => stackHandleFor(partial)).message).includes(
      'no databaseUrl'
    )
  })

  it('refuses a stack id that could leave the registry or change case in Postgres', function () {
    const { dir } = scratch()
    expect(checkStackId('stream-1a')).equals('stream-1a')
    for (const id of ['MyStack', '../etc', 'a/b', '-lead', '']) {
      expect(thrown(() => checkStackId(id))).instanceOf(HarnessError)
    }
    expect(thrown(() => readStack(dir, '../escape'))).instanceOf(HarnessError)
  })

  it('forgets a stack: its entry and its baseline manifest', function () {
    const { dir, handle } = scratch()
    attachStack(dir, handle(HANDLE))
    writeFileSync(baselineFile(dir, HANDLE.id), '{}')
    // The manifest is no entry of its own.
    expect(listStacks(dir).map(row => row.id)).deep.equals([HANDLE.id])
    forgetStack(dir, HANDLE.id)
    expect(listStacks(dir)).deep.equals([])
    expect(readdirSync(dir)).deep.equals([])
  })

  it('calls a malformed or missing handle a harness error', function () {
    const { dir, handle } = scratch()
    const cases: Array<[unknown, string]> = [
      ['{not json', 'not JSON'],
      [[1], 'not a stack handle object'],
      [{ ...HANDLE, version: undefined }, 'no handle version'],
      [{ ...HANDLE, id: 'Has Spaces' }, 'no stack id'],
      [{ ...HANDLE, origin: 'e2e-01.example.test' }, 'no origin URL'],
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
