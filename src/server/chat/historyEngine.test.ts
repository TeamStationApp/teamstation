import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { ChatEngine } from '../../app/chat/engine/engine'
import { type ChatSetup, resetIdentity } from '../../app/chat/engine/links'
import {
  type ChatKeyRecord,
  type ChatKeyStore,
  recordFromJson,
  recordToJson
} from '../../app/chat/keyRecord'
import { TeamStationClient } from '../../common/api'
import { type ChatFixture, openChatFixture } from './chatTestFixture'

class Store implements ChatKeyStore {
  text?: string
  async load(): Promise<ChatKeyRecord | undefined> {
    return this.text == null ? undefined : recordFromJson(this.text)
  }

  async save(record: ChatKeyRecord): Promise<void> {
    this.text = recordToJson(record)
  }

  async exists(): Promise<boolean> {
    return this.text != null
  }

  async wipe(): Promise<void> {
    this.text = undefined
  }
}

describe('chat engine historical recovery over real HTTP', function () {
  this.timeout(120000)
  let f: ChatFixture
  const engines: ChatEngine[] = []
  let enabled = true
  before(async () => {
    const fixture = await openChatFixture('history_engine', {
      freshEpochsEnabled: () => enabled
    })
    if (fixture == null) throw new Error('PostgreSQL 18 is required')
    f = fixture
  })
  after(async () => {
    for (const engine of engines) engine.stop()
    await f?.close()
  })
  function device(
    who: string,
    key = who,
    store = new Store()
  ): {
    client: TeamStationClient
    store: Store
    setup: ChatSetup
    engine: ChatEngine
  } {
    const client = new TeamStationClient({
      baseUrl: f.api,
      token: f.tokenOf(who)
    })
    const setup: ChatSetup = {
      client,
      store,
      userId: f.id(key),
      device: { name: who, platform: 'web' }
    }
    const engine = new ChatEngine({ ...setup, client })
    engines.push(engine)
    return { client, store, setup, engine }
  }
  it('sends before approval, preserves the holder history, then unlocks without socket hints', async () => {
    const a = device('A')
    const b = device('G1')
    expect(await a.engine.start()).equals('ready')
    expect(await b.engine.start()).equals('ready')
    const { id } = await a.client.createDm([f.id('G1')])
    await a.engine.sendText(id, 'old text')
    expect((await b.engine.open(id)).messages[0].body).equals('old text')
    b.engine.stop()
    await f.signIn('G1~recovery', 'G1')
    const fresh = device('G1~recovery', 'G1')
    expect(await fresh.engine.start()).equals('link')
    await resetIdentity(fresh.setup, (await fresh.store.load())!)
    expect(await fresh.engine.start()).equals('ready')
    let view = await fresh.engine.open(id)
    expect(view.sendReadiness).equals('canStartFresh')
    expect(view.composer).equals('enabled')
    expect(view.messages.map(m => m.status)).deep.equals(['locked'])
    expect((await fresh.client.chatEpochs(id, 0)).latest).equals(1)
    await fresh.engine.sendText(id, 'new text')
    view = fresh.engine.view(id)!
    expect(view.messages.map(m => m.status)).deep.equals(['locked', 'ok'])
    expect((await a.engine.open(id)).messages.map(m => m.body)).deep.equals([
      'old text',
      'new text'
    ])
    await a.engine.fillGrants()
    await fresh.engine.refresh()
    await fresh.engine.idle()
    expect(fresh.engine.view(id)!.messages[0].status).equals('locked')
    const approval = a.engine
      .approvals()
      .find(r => r.conversationId === id && r.history === true)
    expect(approval).not.equals(undefined)
    expect(approval!.canApprove).equals(true)
    enabled = false // Disabling fresh publication must not disable existing recovery.
    await a.engine.approve(approval!.requestId)
    await fresh.engine.refresh()
    await fresh.engine.idle()
    view = fresh.engine.view(id)!
    expect(view.messages.map(m => m.body)).deep.equals(['old text', 'new text'])
    expect(view.historyLocked).equals(false)
    expect(view.sendReadiness).equals('ready')
    fresh.engine.stop()
    const restarted = device('G1~recovery', 'G1', fresh.store)
    expect(await restarted.engine.start()).equals('ready')
    expect(
      (await restarted.engine.open(id)).messages.map(m => m.body)
    ).deep.equals(['old text', 'new text'])
  })
})
