import { expect } from 'chai'
import { describe, it } from 'mocha'

import { ChatCryptoUnavailable } from '../../common/chatCrypto/coreCall'
import { asChatWake, asEventReminder, asPushPayload } from '../../common/push'
import {
  depsOf,
  recordOfVector,
  type WakeCase,
  wakeCases,
  wakeVectors
} from '../../test/chatWakeCases'
import { type ChatKeyRecord, epochKeyOf } from '../chat/keyRecord'
import { openWake, type WakeDeps } from './chatWake'

/**
 * Opening chat wakes with the real chat crypto, over the cases
 * `chatWakeCases.ts` makes (and `scripts/pushWakeVectors.ts` writes for the
 * iOS extension). Every case checks that the record is as it was.
 */

const cases = wakeCases()
const named = (name: string): WakeCase => {
  const found = cases.find(item => item.name === name)
  if (found == null) throw new Error(`No wake case ${name}`)
  return found
}

/** Opens a wake and checks the record it was given is unchanged. */
async function open(
  item: WakeCase,
  deps: WakeDeps = depsOf(item)
): Promise<Awaited<ReturnType<typeof openWake>>> {
  const before = structuredClone(deps.record)
  const shown = await openWake(item.wake, deps)
  expect(deps.record).deep.equals(before)
  return shown
}

describe('opening a chat wake on the device', function () {
  for (const item of cases) {
    it(`shows what the ${item.name} case expects, and leaves the record as it was`, async function () {
      expect(await open(item)).deep.equals(item.expected)
    })
  }

  it('names the sender and the message for a DM', async function () {
    expect(await open(named('dm'))).deep.equals({
      title: 'Clayton K',
      body: 'Bring water and a glove.',
      url: 'teamstation://chat/cnv_wakeDm',
      tag: 'chat:cnv_wakeDm'
    })
  })

  it('names the sender and the chat for a mention, and nothing for another message', async function () {
    expect((await open(named('mention')))?.title).equals(
      'Clayton K in Eagles Members'
    )
    expect(await open(named('groupPlain'))).equals(null)
  })

  it('shows nothing for a reaction, an edit or a delete, without fetching', async function () {
    for (const name of ['reaction', 'edit', 'delete']) {
      const calls: string[] = []
      expect(await open(named(name), depsOf(named(name), calls))).equals(null)
      expect(calls).deep.equals([])
    }
  })

  it('reads an inline envelope without fetching it, and fetches one that is not', async function () {
    const inlineCalls: string[] = []
    await open(named('dm'), depsOf(named('dm'), inlineCalls))
    expect(inlineCalls).deep.equals(['epochs cnv_wakeDm 0'])
    const fetched = named('fetched')
    expect(fetched.wake.env).equals(undefined)
    const calls: string[] = []
    expect((await open(fetched, depsOf(fetched, calls)))?.body).equals(
      'Bring water and a glove.'
    )
    expect(calls).deep.equals(['message cnv_wakeDm 7', 'epochs cnv_wakeDm 0'])
  })

  it('opens an epoch key it does not hold from its box, or down the chain, and keeps neither', async function () {
    for (const name of ['uncachedEpoch', 'chainedEpoch']) {
      const item = named(name)
      const record = item.record!
      expect(epochKeyOf(record, item.wake.c, item.wake.env!.epoch)).equals(
        undefined
      )
      expect((await open(item))?.body).not.equals(undefined)
      expect(epochKeyOf(record, item.wake.c, item.wake.env!.epoch)).equals(
        undefined
      )
    }
  })

  it('shows nothing for a group message whose signature fails', async function () {
    expect(await open(named('groupBadSignature'))).equals(null)
  })

  it('still says who wrote a DM it cannot open', async function () {
    expect(await open(named('dmUndecryptable'))).deep.equals({
      title: 'Clayton K',
      body: 'New message from Clayton K',
      url: 'teamstation://chat/cnv_wakeLocked',
      tag: 'chat:cnv_wakeLocked'
    })
  })

  it('says what an attachment-only post holds', async function () {
    expect((await open(named('attachmentOnly')))?.body).equals('Photo')
  })

  it('takes a record for another user as no record: a DM falls back, a group shows nothing', async function () {
    const other = named('dm').record!
    const stranger: ChatKeyRecord = {
      ...other,
      userId: 'usr_1111111111111111111114'
    }
    const dm = named('dm')
    expect(await open(dm, { ...depsOf(dm), record: stranger })).deep.equals(
      named('dmNoRecord').expected
    )
    const group = named('mention')
    expect(await open(group, { ...depsOf(group), record: stranger })).equals(
      null
    )
  })

  it('falls back when the message cannot be had or is not the one woken for', async function () {
    const fetched = named('fetched')
    const fallback = named('dmNoRecord').expected
    // The server answers nothing.
    expect(
      await open(fetched, {
        ...depsOf(fetched),
        fetchMessage: async () => undefined
      })
    ).deep.equals(fallback)
    // The server answers another message.
    expect(
      await open(fetched, {
        ...depsOf(fetched),
        fetchMessage: async () => ({ ...fetched.message!, seq: 8 })
      })
    ).deep.equals(fallback)
    // The network fails.
    expect(
      await open(fetched, {
        ...depsOf(fetched),
        fetchEpochs: async () => {
          throw new ChatCryptoUnavailable('loading')
        }
      })
    ).deep.equals(fallback)
    // A group's failure shows nothing.
    const group = named('mention')
    expect(
      await open(group, {
        ...depsOf(group),
        fetchEpochs: async () => {
          throw new Error('offline')
        }
      })
    ).equals(null)
  })
})

describe('the push payload cleaners', function () {
  it('read a wake as the server encodes it, with and without its envelope', function () {
    const { wake } = named('dm')
    expect(asChatWake(JSON.parse(JSON.stringify(wake)))).deep.equals(wake)
    const { env: _env, ...bare } = wake
    expect(asChatWake(JSON.parse(JSON.stringify(bare))).env).equals(undefined)
    expect(asPushPayload(JSON.parse(JSON.stringify(wake))).t).equals('chat')
  })

  it('read a reminder, and refuse anything else', function () {
    const reminder = {
      t: 'event',
      u: 'usr_1111111111111111111112',
      title: 'Hawks vs Owls',
      body: 'Starts at 5:30 PM',
      url: 'teamstation://games/gam_1',
      tag: 'event:gam_1'
    }
    expect(asEventReminder(reminder)).deep.equals(reminder)
    expect(asPushPayload(reminder).t).equals('event')
    expect(() => asPushPayload({ ...reminder, t: 'other' })).throws(TypeError)
    expect(() => asChatWake({ ...named('dm').wake, title: 3 })).throws(
      TypeError
    )
  })
})

describe('the wake test vectors', function () {
  it('open from their JSON to what each expects', async function () {
    const { version, cases: vectors } = JSON.parse(
      JSON.stringify(wakeVectors())
    ) as ReturnType<typeof wakeVectors>
    expect(version).equals(1)
    expect(vectors.map(vector => vector.name)).deep.equals(
      cases.map(item => item.name)
    )
    for (const vector of vectors) {
      expect(vector.record ?? {}).not.have.property('device')
      const item: WakeCase = {
        ...vector,
        wake: asChatWake(vector.wake),
        record:
          vector.record == null ? undefined : recordOfVector(vector.record),
        message: vector.message ?? undefined
      }
      expect(await open(item), vector.name).deep.equals(vector.expected)
    }
  })
})
