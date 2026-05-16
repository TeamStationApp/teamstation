/**
 * Lifecycle / leak regression tests for the RTMP splitter.
 *
 * The splitter's outbound ffmpeg children are managed by an exit handler
 * that schedules a restart via setTimeout when the child dies. If the
 * runtime that owns the child gets replaced (setSplit / clearSplit) while
 * a restart is pending, the orphan handler must NOT spawn another ffmpeg
 * against the now-stale destination URL.
 *
 * These tests stub out child_process.spawn with a controllable fake so
 * they run quickly and deterministically without needing real ffmpeg or
 * a real network.
 */
import { expect } from 'chai'
import { EventEmitter } from 'events'
import { describe, it } from 'mocha'
import { PassThrough } from 'stream'

interface FakeChild extends EventEmitter {
  pid: number
  killed: boolean
  stdout: PassThrough
  stderr: PassThrough
  kill: (signal?: NodeJS.Signals | number) => boolean
  fakeExit: (code: number) => void
}

interface SpawnRecord {
  url: string
  child: FakeChild
}

// Fake-child PIDs are assigned from a deliberately-very-high range so
// the splitter's new isPidAlive() probe -- which calls
// `process.kill(pid, 0)` -- never accidentally collides with a real
// process on the test runner. Linux's pid_max is at most 2^22, so any
// value above that is guaranteed to return ESRCH.
let nextPid = 1_000_000_000

function makeFakeChild(url: string): FakeChild {
  const emitter = new EventEmitter() as FakeChild
  emitter.pid = nextPid++
  emitter.killed = false
  emitter.stdout = new PassThrough()
  emitter.stderr = new PassThrough()
  emitter.kill = (_signal?: NodeJS.Signals | number): boolean => {
    if (emitter.killed) return false
    emitter.killed = true
    setImmediate(() => {
      emitter.fakeExit(0)
    })
    return true
  }
  emitter.fakeExit = (code: number): void => {
    emitter.emit('exit', code, null)
  }
  ;(emitter as any).__url = url
  return emitter
}

/**
 * Replace child_process.spawn in the require cache with a controllable
 * fake BEFORE the splitter module is loaded. Returns the list of spawn
 * calls that the test can inspect.
 */
function installFakeSpawn(): {
  spawned: SpawnRecord[]
  restore: () => void
} {
  const cp = require('child_process')
  const original = cp.spawn
  const spawned: SpawnRecord[] = []
  cp.spawn = (_bin: string, args: string[]): FakeChild => {
    // The destination URL is the LAST positional ffmpeg argument.
    const url = args[args.length - 1] ?? ''
    const child = makeFakeChild(url)
    spawned.push({ url, child })
    return child
  }
  return {
    spawned,
    restore: () => {
      cp.spawn = original
    }
  }
}

interface SplitterModule {
  setSplit: (
    eventId: string,
    destinations: string[]
  ) => { ok: boolean; error?: string }
  stopSplit: (eventId: string) => boolean
  clearSplit: (eventId: string) => boolean
  getStatusSnapshot: (eventId: string) => unknown
  forcePublishForTest: (eventId: string, publishing: boolean) => void
}

function loadSplitter(): SplitterModule {
  // Force a fresh module load so each test gets a clean splits map and
  // the freshly-installed fake spawn is captured by the module's
  // top-level imports.
  const key = require.resolve('../server/rtmp/splitter')
  Reflect.deleteProperty(require.cache as Record<string, unknown>, key)
  return require('../server/rtmp/splitter') as SplitterModule
}

const DEST_A = 'rtmp://example-a.test:1935/live/keyA'
const DEST_B = 'rtmp://example-b.test:1935/live/keyB'
const DEST_C = 'rtmp://example-c.test:1935/live/keyC'
const DEST_D = 'rtmp://example-d.test:1935/live/keyD'

describe('rtmp splitter lifecycle', () => {
  let restoreSpawn: (() => void) | undefined

  afterEach(() => {
    restoreSpawn?.()
    restoreSpawn = undefined
  })

  it('setSplit replaces destinations and clears outbound state', () => {
    const fake = installFakeSpawn()
    restoreSpawn = fake.restore
    const splitter = loadSplitter()

    splitter.setSplit('evt1', [DEST_A, DEST_B])
    let snap = splitter.getStatusSnapshot('evt1') as {
      destinations: string[]
      outbounds: Array<{ url: string; state: string; bytesSent: number }>
    } | null
    expect(snap, 'after first setSplit').to.not.equal(null)
    expect(snap!.destinations).to.deep.equal([DEST_A, DEST_B])
    expect(snap!.outbounds.map(o => o.url)).to.deep.equal([DEST_A, DEST_B])

    splitter.setSplit('evt1', [DEST_C, DEST_D])
    snap = splitter.getStatusSnapshot('evt1') as typeof snap
    expect(snap!.destinations).to.deep.equal([DEST_C, DEST_D])
    expect(snap!.outbounds.map(o => o.url)).to.deep.equal([DEST_C, DEST_D])
    for (const o of snap!.outbounds) {
      expect(o.state).to.equal('idle')
      expect(o.bytesSent).to.equal(0)
    }
  })

  it('setSplit accepts 1 to 4 destinations and rejects out-of-range arrays', () => {
    const fake = installFakeSpawn()
    restoreSpawn = fake.restore
    const splitter = loadSplitter()

    // Empty array → rejected
    let res = splitter.setSplit('evt1b', [])
    expect(res.ok, 'empty array rejected').to.equal(false)
    expect(res.error ?? '').to.match(/array of 1 to 4/)

    // 5+ destinations → rejected
    res = splitter.setSplit('evt1b', [DEST_A, DEST_B, DEST_C, DEST_D, DEST_A])
    expect(res.ok, '5 destinations rejected').to.equal(false)

    // Single destination → accepted
    res = splitter.setSplit('evt1b', [DEST_A])
    expect(res.ok, res.error ?? '').to.equal(true)
    const snap = splitter.getStatusSnapshot('evt1b') as {
      destinations: string[]
      outbounds: Array<{ url: string }>
    } | null
    expect(snap!.destinations).to.deep.equal([DEST_A])
    expect(snap!.outbounds.map(o => o.url)).to.deep.equal([DEST_A])

    // Upgrading from 1 → 2 destinations works
    splitter.setSplit('evt1b', [DEST_A, DEST_B])
    const snap2 = splitter.getStatusSnapshot('evt1b') as typeof snap
    expect(snap2!.destinations).to.deep.equal([DEST_A, DEST_B])

    // Three destinations → accepted
    splitter.setSplit('evt1b', [DEST_A, DEST_B, DEST_C])
    const snap3 = splitter.getStatusSnapshot('evt1b') as typeof snap
    expect(snap3!.destinations).to.deep.equal([DEST_A, DEST_B, DEST_C])
    expect(snap3!.outbounds.map(o => o.url)).to.deep.equal([
      DEST_A,
      DEST_B,
      DEST_C
    ])

    // Four destinations → accepted
    splitter.setSplit('evt1b', [DEST_A, DEST_B, DEST_C, DEST_D])
    const snap4 = splitter.getStatusSnapshot('evt1b') as typeof snap
    expect(snap4!.destinations).to.deep.equal([DEST_A, DEST_B, DEST_C, DEST_D])
    expect(snap4!.outbounds.map(o => o.url)).to.deep.equal([
      DEST_A,
      DEST_B,
      DEST_C,
      DEST_D
    ])

    // Downgrading from 4 → 1 destination works
    splitter.setSplit('evt1b', [DEST_C])
    const snap5 = splitter.getStatusSnapshot('evt1b') as typeof snap
    expect(snap5!.destinations).to.deep.equal([DEST_C])
  })

  it('orphan exit handler does not spawn new ffmpeg after reconfigure', done => {
    const fake = installFakeSpawn()
    restoreSpawn = fake.restore
    const splitter = loadSplitter()

    // Configure dest A,B and force-publish so children get spawned
    splitter.setSplit('evt2', [DEST_A, DEST_B])
    // Manually flip publishing → start outbounds (we cannot use NMS here)
    forcePublish(splitter, 'evt2', true)

    expect(fake.spawned.map(s => s.url)).to.deep.equal([DEST_A, DEST_B])
    const childA = fake.spawned[0].child
    const childB = fake.spawned[1].child

    // Reconfigure to C,D BEFORE the original children exit. setSplit
    // must SIGTERM the originals and replace the runtimes.
    splitter.setSplit('evt2', [DEST_C, DEST_D])

    // SIGTERM kicks off fake exits via setImmediate. Wait one tick.
    setImmediate(() => {
      // After the reconfigure + SIGTERM-driven exits, the exit handler
      // for the OLD A/B runtimes must NOT schedule new spawns against
      // DEST_A or DEST_B. The next ffmpeg children should be C and D
      // (started by setSplit's startOutbounds since publishing is true).
      const urls = fake.spawned.map(s => s.url)
      expect(urls).to.include(DEST_A)
      expect(urls).to.include(DEST_B)
      expect(urls).to.include(DEST_C)
      expect(urls).to.include(DEST_D)
      // No DUPLICATE A or B spawns from a delayed restart timer.
      const countA = urls.filter(u => u === DEST_A).length
      const countB = urls.filter(u => u === DEST_B).length
      expect(countA, 'DEST_A spawns').to.equal(1)
      expect(countB, 'DEST_B spawns').to.equal(1)

      // Now simulate a NATURAL exit of the old children with a non-zero
      // code (as if the destination had EPIPE'd them). This is the path
      // that previously orphaned them: the closure-captured `outbound`
      // still references the retired runtime.
      childA.fakeExit(251)
      childB.fakeExit(251)

      // Wait long enough for any restartTimer to fire. Backoff[0] is
      // 1000ms, so 1500ms is plenty.
      setTimeout(() => {
        const finalCountA = fake.spawned.filter(s => s.url === DEST_A).length
        const finalCountB = fake.spawned.filter(s => s.url === DEST_B).length
        expect(finalCountA, 'no DEST_A respawn').to.equal(1)
        expect(finalCountB, 'no DEST_B respawn').to.equal(1)
        done()
      }, 1500)
    })
  }).timeout(5000)

  it('stopSplit deactivates forwarding without clearing destinations', done => {
    const fake = installFakeSpawn()
    restoreSpawn = fake.restore
    const splitter = loadSplitter()

    splitter.setSplit('evtStop', [DEST_A, DEST_B])
    splitter.forcePublishForTest('evtStop', true)
    expect(fake.spawned.map(s => s.url)).to.deep.equal([DEST_A, DEST_B])
    const childA = fake.spawned[0].child
    const childB = fake.spawned[1].child

    // Stop the splitter. Destinations and outbound runtime objects must
    // remain so the UI can keep showing the URLs and "Stopped" status.
    splitter.stopSplit('evtStop')
    const snap = splitter.getStatusSnapshot('evtStop') as {
      destinations: string[]
      outbounds: Array<{ url: string; state: string }>
    } | null
    expect(snap, 'snapshot after stopSplit').to.not.equal(null)
    expect(snap!.destinations, 'destinations preserved').to.deep.equal([
      DEST_A,
      DEST_B
    ])
    expect(snap!.outbounds.map(o => o.url)).to.deep.equal([DEST_A, DEST_B])
    for (const o of snap!.outbounds) {
      expect(o.state, `${o.url} state`).to.equal('stopped')
    }

    // SIGTERM-driven exit + a delayed natural exit must NOT spawn new
    // ffmpeg children; the runtimes are released.
    setImmediate(() => {
      childA.fakeExit(251)
      childB.fakeExit(251)
      // Even if the publisher reconnects after stop, no respawn:
      splitter.forcePublishForTest('evtStop', false)
      splitter.forcePublishForTest('evtStop', true)
      setTimeout(() => {
        const respawnsA = fake.spawned.filter(s => s.url === DEST_A).length
        const respawnsB = fake.spawned.filter(s => s.url === DEST_B).length
        expect(respawnsA, 'no respawn after stopSplit').to.equal(1)
        expect(respawnsB, 'no respawn after stopSplit').to.equal(1)

        // Re-saving the same destinations resumes forwarding by
        // installing fresh runtime objects.
        splitter.setSplit('evtStop', [DEST_A, DEST_B])
        const respawnsA2 = fake.spawned.filter(s => s.url === DEST_A).length
        const respawnsB2 = fake.spawned.filter(s => s.url === DEST_B).length
        expect(respawnsA2, 'resume spawns DEST_A').to.equal(2)
        expect(respawnsB2, 'resume spawns DEST_B').to.equal(2)
        done()
      }, 1500)
    })
  }).timeout(5000)

  it('a duplicate exit event on the same child does not double-spawn or double-count restarts', done => {
    const fake = installFakeSpawn()
    restoreSpawn = fake.restore
    const splitter = loadSplitter()

    splitter.setSplit('evtDup', [DEST_A])
    splitter.forcePublishForTest('evtDup', true)
    expect(fake.spawned).to.have.length(1)
    const child1 = fake.spawned[0].child

    // Fire 'exit' twice in rapid succession on the SAME ChildProcess.
    // Node has been observed to do this for ffmpeg children in
    // production; the splitter's de-dup guard must handle it.
    child1.fakeExit(251)
    child1.fakeExit(251)

    // After the (single) restart backoff fires we should see exactly
    // ONE additional spawn -- the canonical restart -- not two.
    setTimeout(() => {
      const totalA = fake.spawned.filter(s => s.url === DEST_A).length
      expect(totalA, 'spawns for DEST_A after double-exit').to.equal(2)
      const snap = splitter.getStatusSnapshot('evtDup') as {
        outbounds: Array<{ restartCount: number }>
      } | null
      expect(
        snap!.outbounds[0].restartCount,
        'restartCount not double-incremented'
      ).to.equal(1)
      done()
    }, 1500)
  }).timeout(3000)

  it('stopSplit sends SIGTERM to every still-tracked child (not just the canonical current one)', done => {
    const fake = installFakeSpawn()
    restoreSpawn = fake.restore
    const splitter = loadSplitter()

    splitter.setSplit('evtMulti', [DEST_A])
    splitter.forcePublishForTest('evtMulti', true)
    expect(fake.spawned).to.have.length(1)
    const child1 = fake.spawned[0].child

    // Suppress child1's auto-exit so it remains in outbound.spawned
    // even after we tell the splitter we believe it died. Track which
    // signals it actually receives.
    const child1Signals: Array<NodeJS.Signals | number | undefined> = []
    child1.kill = (signal?: NodeJS.Signals | number): boolean => {
      child1Signals.push(signal)
      return true
    }

    // Simulated NORMAL exit -> a real restart kicks in. After the
    // backoff fires the splitter spawns child2 and outbound.child
    // points at child2. child1 is removed from outbound.spawned by the
    // (non-phantom) branch of the exit handler.
    child1.fakeExit(251)

    setTimeout(() => {
      expect(fake.spawned.length, 'restart spawned child2').to.equal(2)
      const child2 = fake.spawned[1].child
      const child2Signals: Array<NodeJS.Signals | number | undefined> = []
      child2.kill = (signal?: NodeJS.Signals | number): boolean => {
        child2Signals.push(signal)
        return true
      }
      // stopSplit must SIGTERM child2 (the current canonical child).
      // child1 was already cleanly removed when its exit fired, so it
      // should NOT be re-signalled.
      splitter.stopSplit('evtMulti')
      expect(child2Signals, 'child2 SIGTERM').to.deep.equal(['SIGTERM'])
      expect(child1Signals, 'child1 not re-signalled').to.deep.equal([])
      done()
    }, 1300)
  }).timeout(3000)

  it('clearSplit retires outbounds even when publisher is offline', done => {
    const fake = installFakeSpawn()
    restoreSpawn = fake.restore
    const splitter = loadSplitter()

    splitter.setSplit('evt3', [DEST_A, DEST_B])
    forcePublish(splitter, 'evt3', true)
    expect(fake.spawned.map(s => s.url)).to.deep.equal([DEST_A, DEST_B])
    const [{ child: childA }, { child: childB }] = fake.spawned

    // Publisher disconnects; donePublish would normally stop outbounds
    forcePublish(splitter, 'evt3', false)
    splitter.clearSplit('evt3')

    // After clear, simulating a delayed natural exit must NOT lead to a
    // respawn even though the publisher could theoretically come back.
    setImmediate(() => {
      childA.fakeExit(251)
      childB.fakeExit(251)
      // Even if publishing flips back on, the runtimes are released.
      forcePublish(splitter, 'evt3', true)
      setTimeout(() => {
        const respawnsA = fake.spawned.filter(s => s.url === DEST_A).length
        const respawnsB = fake.spawned.filter(s => s.url === DEST_B).length
        expect(respawnsA, 'DEST_A respawns after clear').to.equal(1)
        expect(respawnsB, 'DEST_B respawns after clear').to.equal(1)
        done()
      }, 1500)
    })
  }).timeout(5000)
})

function forcePublish(
  splitter: SplitterModule,
  eventId: string,
  publishing: boolean
): void {
  splitter.forcePublishForTest(eventId, publishing)
}
