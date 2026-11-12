import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'

import {
  attachStack,
  listStacks,
  parseHandle,
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
    expect(removeStack(dir, HANDLE.id, pid => killed.push(pid))).deep.equals({
      id: HANDLE.id,
      stopped: false
    })
    writeFileSync(
      join(dir, 'up.json'),
      JSON.stringify({ id: 'up', origin: 'http://x.test', pid: 4242 })
    )
    expect(removeStack(dir, 'up', pid => killed.push(pid)).stopped).equals(true)
    expect(killed).deep.equals([4242])
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
