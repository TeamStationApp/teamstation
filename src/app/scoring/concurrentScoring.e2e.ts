import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { ConcurrentScoringRig } from '../../test/concurrentScoring/concurrentScoring'
import { ConcurrentScoringSafariRig } from '../../test/concurrentScoring/concurrentScoringSafari'
import { conflictingPitches } from '../../test/concurrentScoring/conflicts'
import type {
  E2eContext,
  FixtureManifest
} from '../../test/concurrentScoring/context'
import { fourInnings } from '../../test/concurrentScoring/game'
import { networkRecovery } from '../../test/concurrentScoring/networkRecovery'
import { browserSession, maestro } from '../../test/refinementsMaestro.e2e'

const required = (name: string): string => {
  const value = process.env[name]
  assert(value != null && value !== '', `${name} is required`)
  return value
}
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const option = (name: string, fallback: string): string => {
    const at = args.indexOf(`--${name}`)
    return at < 0 ? fallback : args[at + 1]
  }
  const scenario = option('scenario', 'four-innings')
  const surface = option('surface', 'chromium')
  assert(
    [
      'follow',
      'lineups',
      'four-innings',
      'conflicts',
      'network-recovery'
    ].includes(scenario)
  )
  assert(['chromium', 'safari'].includes(surface))
  const origin = required('TS_CONCURRENT_ORIGIN')
  const artifacts = resolve(required('TS_CONCURRENT_ARTIFACTS'))
  await mkdir(artifacts, { recursive: true })
  const fixture: FixtureManifest = JSON.parse(
    await readFile(required('TS_CONCURRENT_FIXTURE'), 'utf8')
  )
  assert.equal(fixture.world, 'concurrent-scoring')
  const run = `concurrent-${randomUUID().slice(0, 8)}`
  const cleanup: Array<() => Promise<void>> = []
  const note = async (value: unknown): Promise<void> => {
    const line = JSON.stringify({ at: new Date().toISOString(), value })
    console.log(line)
    await appendFile(join(artifacts, `${scenario}.log`), line + '\n')
  }
  await appendFile(
    join(artifacts, `${scenario}.log`),
    '$ node -r sucrase/register src/app/scoring/concurrentScoring.e2e.ts ' +
      args.join(' ') +
      '\n'
  )
  const devices =
    surface === 'safari'
      ? [required('TS_CONCURRENT_DEVICE_A'), required('TS_CONCURRENT_DEVICE_B')]
      : []
  if (surface === 'safari') assert.notEqual(devices[0], devices[1])
  const ctx: E2eContext = {
    stack: { origin },
    artifact: name => join(artifacts, name),
    fixture: async () => fixture,
    browser: async size => {
      const name = `${run}-${cleanup.length}`
      const d = await maestro(name)
      cleanup.push(async () => {
        await d.shutdown()
      })
      const b = await browserSession(
        d,
        name,
        size.width,
        size.height,
        artifacts
      )
      cleanup.push(async () => {
        await b.browser.disconnect()
        await b.m.detach()
      })
      return { ...b, close: async () => {} }
    },
    signIn: async (role, m) => {
      const account = fixture.accounts[role]
      await m.tapOn({ text: '^Use a password instead$', timeout: 30000 })
      await m.tapOn({ text: '^E-mail address$' })
      await m.inputText({ text: account.email })
      await m.tapOn({ text: '^Password$' })
      await m.inputText({ text: account.password })
      await m.tapOn({ text: 'Sign in', role: 'button' })
      await m.assertVisible({ text: 'Account, .*', timeout: 30000 })
    },
    attach: async (role, options) => {
      assert(
        Date.now() < Date.parse(required('TS_CONCURRENT_LEASE_UNTIL')),
        'Physical device lease must remain valid'
      )
      const d = await maestro(`${run}-${role}`)
      cleanup.push(async () => {
        await d.shutdown()
      })
      const m = await d.attach({
        ...options,
        device: devices[role === 'scorer-a' ? 0 : 1]
      })
      return new Proxy(m, {
        get: (target, key) => {
          const value = Reflect.get(target, key)
          if (typeof value !== 'function') return value
          return (...parameters: unknown[]) => {
            assert(
              Date.now() < Date.parse(required('TS_CONCURRENT_LEASE_UNTIL')),
              'Renew physical device lease before continuing'
            )
            return value.apply(target, parameters)
          }
        }
      })
    },
    checkpoint: async (id, options) => {
      await options.readBack()
      await note({ checkpoint: id, status: 'passed' })
    }
  }
  const rig =
    surface === 'safari'
      ? new ConcurrentScoringSafariRig(ctx)
      : new ConcurrentScoringRig(ctx)
  try {
    if (scenario === 'four-innings') await fourInnings(rig, ctx)
    else if (scenario === 'network-recovery') {
      assert.equal(surface, 'safari')
      await networkRecovery(rig)
    } else if (scenario === 'conflicts') await conflictingPitches(rig)
    else if (scenario === 'lineups') {
      await rig.open()
      await rig.pitch(1, 'Ball')
      await rig.coachChange()
      await rig.converge(1, 'coach reorder after scoring starts')
    } else {
      await rig.open()
      await rig.hit(1, 'Single')
      await rig.finish(1)
      await rig.boundary(1, 1)
      await rig.pitch(0, 'Ball')
      await rig.agree(0, '1 balls 0 strikes')
      await rig.capture('follow-after')
    }
    await note({ status: 'passed', scenario, interventions: 0 })
  } catch (error) {
    await rig.capture('failure').catch(() => {})
    await note({ status: 'failed', error: String(error) })
    throw error
  } finally {
    for (const close of cleanup.reverse()) await close().catch(() => {})
  }
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
