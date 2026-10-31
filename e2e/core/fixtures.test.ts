import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'

import {
  baselineManifestPath,
  findAccount,
  type FixtureManifest,
  readBaselineManifest,
  requireMailbox,
  runSeatFixture,
  signInWithPassword,
  worldIdsOf,
  writeManifestFile
} from './fixtures'
import { lintFile } from './lint'
import {
  gogRunner,
  parseSearch,
  readMail,
  testAddressFor,
  waitForMail
} from './mail'
import { BlockedError, HarnessError } from './result'
import { startStack } from './stack'

const WORLD: FixtureManifest = {
  world: 'w',
  nonce: 'n',
  accounts: {
    coach: {
      role: 'coach',
      email: 'box+c@example.test',
      password: 'pw',
      userId: 'usr_c',
      displayName: 'Dave Roberts'
    }
  },
  ids: { team: 'tem_1' }
}

const BASELINE: FixtureManifest = {
  ...WORLD,
  world: 'baseline',
  accounts: {
    member: { ...WORLD.accounts.coach, role: 'member', userId: 'usr_m' },
    coach: { ...WORLD.accounts.coach, userId: 'usr_baseline' }
  },
  ids: {}
}

async function rejection(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run()
  } catch (error) {
    return error as Error
  }
  throw new Error('expected a rejection')
}

describe('ctx.signIn', function () {
  it('drives the password form with the manifest’s password', async function () {
    const calls: Array<[string, unknown]> = []
    const record =
      (name: string) =>
      async (value: unknown): Promise<void> => {
        calls.push([name, value])
      }
    await signInWithPassword(
      {
        assertVisible: record('see'),
        tapOn: record('tap'),
        inputText: record('type')
      },
      { email: 'box+c@example.test', password: 'pw' }
    )
    expect(calls.map(([name]) => name)).deep.equals([
      'see',
      'tap',
      'tap',
      'type',
      'tap',
      'type',
      'tap',
      'see'
    ])
    expect(calls[3][1]).deep.equals({ text: 'box+c@example.test' })
    expect(calls[5][1]).deep.equals({ text: 'pw' })
    // Only a signed-in person has this, so a refused password fails.
    expect(calls[7][1]).deep.includes({ text: 'Account, .*' })
  })

  it('takes a role from the scenario’s worlds first, then baseline', function () {
    expect(findAccount('coach', [WORLD], BASELINE).userId).equals('usr_c')
    expect(findAccount('member', [WORLD], BASELINE).userId).equals('usr_m')
    const newer = {
      ...WORLD,
      accounts: { coach: { ...WORLD.accounts.coach, userId: 'usr_new' } }
    }
    expect(findAccount('coach', [WORLD, newer], undefined).userId).equals(
      'usr_new'
    )
  })

  it('blocks clearly when a role is missing', function () {
    expect(() => findAccount('umpire', [WORLD], BASELINE))
      .to.throw(BlockedError)
      .with.property('message')
      .that.includes('"umpire"')
  })

  it('finds baseline’s manifest for the tester seat and a stack, never a branch seat', function () {
    const settings = { seatManifest: '/runs/tester-manifest.json' }
    expect(
      baselineManifestPath(settings, { kind: 'seat', seat: 'tester' })
    ).equals('/runs/tester-manifest.json')
    expect(
      baselineManifestPath(settings, { kind: 'seat', seat: 'develop2' })
    ).equals(undefined)
    expect(
      baselineManifestPath(settings, { kind: 'isolated', dir: '/stack' })
    ).equals('/stack/baseline.json')
    expect(baselineManifestPath(settings, { kind: 'isolated' })).equals(
      undefined
    )
    expect(baselineManifestPath(settings, { kind: 'none' })).equals(undefined)
    expect(readBaselineManifest(undefined)).equals(undefined)
    expect(readBaselineManifest('/nonexistent')).equals(undefined)
  })

  it('keeps a manifest on disk only at mode 0600', function () {
    const path = join(mkdtempSync(join(tmpdir(), 'manifest-')), 'baseline.json')
    writeManifestFile(path, BASELINE)
    expect(statSync(path).mode & 0o777).equals(0o600)
    expect(readBaselineManifest(path)?.world).equals('baseline')
  })

  it('claims a seat’s errors by every id its worlds made', function () {
    expect(worldIdsOf([WORLD]).sort()).deep.equals(['tem_1', 'usr_c'])
  })

  it('asks the seat command to seed, and blocks with no command', function () {
    expect(() => runSeatFixture({}, 'tester', 'w')).to.throw(BlockedError)
    const script = join(mkdtempSync(join(tmpdir(), 'seat-')), 'seat.sh')
    writeFileSync(
      script,
      `#!/bin/sh\necho '{"world":"'"$2"'","seat":"'"$4"'"}'\n`,
      { mode: 0o755 }
    )
    expect(
      runSeatFixture({ seatCommand: script }, 'tester', 'team-with-roster')
    ).deep.equals({ world: 'team-with-roster', seat: 'tester' })
  })

  it('needs a mailbox', function () {
    expect(() => requireMailbox({})).to.throw(BlockedError)
    expect(requireMailbox({ mailbox: 'box@example.test' })).equals(
      'box@example.test'
    )
  })
})

describe('ctx.address', function () {
  it('gives a distinct + address on the mailbox for each label and run', function () {
    const a = testAddressFor('box@example.test', 'invite')
    const b = testAddressFor('box@example.test', 'invite')
    const c = testAddressFor('box@example.test', 'guardian')
    expect(a).matches(/^box\+invite-[0-9a-f]{8}@example\.test$/)
    expect(c).matches(/^box\+guardian-/)
    expect(new Set([a, b, c]).size).equals(3)
  })
})

const TABLE = (date: string): string =>
  [
    'ID                DATE              FROM                     SUBJECT',
    `1a0a88c65447d0aa  ${date}  TeamStation <a@b.test>   Your code is 698924`
  ].join('\n')

describe('ctx.mail', function () {
  const NOW = Date.parse('2026-10-31T12:00:00Z')

  it('builds only a targeted, bounded search with --max 3', async function () {
    const calls: string[][] = []
    const found = await waitForMail({
      run: args => {
        calls.push(args)
        return TABLE('2026-10-31 12:00')
      },
      mailbox: 'box@example.test',
      to: 'box+a@example.test',
      from: 'mail@example.test',
      since: NOW
    })
    expect(found.subject).equals('Your code is 698924')
    expect(found.id).equals('1a0a88c65447d0aa')
    expect(calls).deep.equals([
      [
        'gmail',
        'search',
        'to:box+a@example.test from:mail@example.test newer_than:15m',
        '-a',
        'box@example.test',
        '--max',
        '3',
        '-p'
      ]
    ])
  })

  it('ignores a message older than the request', async function () {
    let now = NOW
    const error = await rejection(
      async () =>
        await waitForMail({
          run: () => TABLE('2026-10-31 11:40'),
          mailbox: 'box@example.test',
          to: 'box+a@example.test',
          from: 'mail@example.test',
          since: NOW,
          timeoutMs: 10,
          stepMs: 1,
          now: () => (now += 20)
        })
    )
    expect(error).instanceOf(HarnessError)
    expect(error.message).includes('No mail to box+a@example.test')
    expect(error.message).includes('possibly the provider')
  })

  it('keeps polling until the message arrives', async function () {
    let searches = 0
    const found = await waitForMail({
      run: () =>
        ++searches < 2 ? 'ID DATE FROM SUBJECT\n' : TABLE('2026-10-31 12:01'),
      mailbox: 'box@example.test',
      to: 'box+a@example.test',
      from: 'mail@example.test',
      since: NOW,
      timeoutMs: 1000,
      stepMs: 1
    })
    expect(searches).equals(2)
    expect(found.date.getTime()).greaterThanOrEqual(NOW)
  })

  it('reads an empty or unexpected listing as no mail', function () {
    expect(parseSearch('')).deep.equals([])
    expect(parseSearch('No results')).deep.equals([])
  })

  it('opens only the message it was given, on the named mailbox', function () {
    const calls: string[][] = []
    expect(
      readMail(
        args => {
          calls.push(args)
          return 'body'
        },
        'box@example.test',
        'abc'
      )
    ).equals('body')
    expect(calls).deep.equals([
      ['gmail', 'read', 'abc', '-a', 'box@example.test']
    ])
  })

  it('blocks with no way to read mail, and passes the mailbox’s account through', function () {
    expect(() => gogRunner({})).to.throw(BlockedError)
    const dir = mkdtempSync(join(tmpdir(), 'gog-'))
    const env = join(dir, 'env')
    writeFileSync(env, `export PATH="${dir}:$PATH"\n`)
    writeFileSync(join(dir, 'gog'), '#!/bin/sh\necho "args: $*"\n', {
      mode: 0o755
    })
    expect(gogRunner({ gogEnvFile: env })(['gmail', 'read', 'x'])).includes(
      'args: gmail read x'
    )
  })
})

describe('the address lint', function () {
  const rules = (text: string): string[] =>
    lintFile('e2e/tests/a/b/c.e2e.ts', `ctx.checkpoint(); ${text}`).map(
      row => row.rule
    )

  it('rejects any address but a reserved one, in a scenario that sends nothing', function () {
    const at = '@'
    expect(rules(`'person${at}gmail.com'`)).includes('no-real-address')
    expect(rules(`'pat${at}example.test'`)).includes('no-real-address')
    expect(rules(`'pat${at}example.test', sendsNoMail: true`)).not.includes(
      'no-real-address'
    )
    expect(rules(`'person${at}gmail.com', sendsNoMail: true`)).includes(
      'no-real-address'
    )
    expect(rules('ctx.address("invite")')).not.includes('no-real-address')
  })
})

describe('a stack’s fixtures', function () {
  this.timeout(120000)

  it('seeds baseline from nothing, at mode 0600, and seeds worlds for a scenario', async function () {
    const stack = await startStack({
      services: ['api'],
      mailbox: 'box@example.test'
    })
    try {
      const path = stack.baselineManifest ?? ''
      expect(statSync(path).mode & 0o777).equals(0o600)
      const baseline = readBaselineManifest(path)
      expect(Object.keys(baseline?.accounts ?? {}).sort()).deep.equals([
        'admin',
        'member'
      ])
      const world = await stack.seedWorld?.('team-with-roster')
      expect(world?.accounts.coach.email).matches(
        /^box\+team-with-roster-coach-/
      )
    } finally {
      await stack.stop()
    }
  })

  it('has no baseline with no mailbox, and blocks seeding a world', async function () {
    const stack = await startStack({ services: ['api'] })
    try {
      expect(readBaselineManifest(stack.baselineManifest)).equals(undefined)
      const error = await rejection(
        async () => await stack.seedWorld?.('team-with-roster')
      )
      expect(error).instanceOf(BlockedError)
    } finally {
      await stack.stop()
    }
  })
})
