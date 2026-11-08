import { readFileSync } from 'node:fs'
import Module from 'node:module'
import { resolve } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'
import { transform } from 'sucrase'

import { makeDatabase } from './db/database'

/** Execute the composition root with disconnected service boundaries. Stop before listening. */
describe('server history recovery wiring', () => {
  it('mounts recovery routes with the configured live publication switch', () => {
    const file = resolve(__dirname, 'index.ts')
    const config = {
      clusterWorkers: 1,
      mediaSecret: 'synthetic',
      sentry: {},
      workDir: '/unused',
      appLinks: { apps: [] },
      redis: { url: 'redis://invalid.example.test', prefix: 'test:' },
      chatHistoryRecoveryEnabled: false
    }
    const mounted = Symbol('history routes')
    const stop = new Error('composition observed')
    let flag: (() => boolean) | undefined
    let clock: (() => Date) | undefined
    const database = {}
    const app = {
      set: () => {},
      disable: () => {},
      get: () => {},
      use: (...args: unknown[]) => {
        if (args.includes(mounted)) throw stop
      }
    }
    const noop = (): undefined => undefined
    const services = new Proxy({}, { get: () => noop })
    const isolated = new Module(file, module) as Module & {
      _compile: (source: string, filename: string) => void
    }
    isolated.filename = file
    isolated.require = (name: string): any => {
      if (name.startsWith('node:')) return require(name)
      if (name === 'express') return () => app
      if (name === './serverConfig')
        return {
          serverConfig: config,
          requestDatabaseUrl: () => 'postgres://invalid.example.test/unused',
          speechSettings: noop,
          tessSettings: noop,
          publicUrl: 'https://example.test',
          primaryHost: 'example.test'
        }
      if (name === './db/database') return { makeDatabase: () => database }
      if (name === './scoreboard/scoreboardService')
        return { startScoreboard: () => ({ store: {}, hub: {} }) }
      if (name === './scoreboard/scoreboardStore') {
        const client = { connect: async () => {} }
        return {
          makeScoreboardClient: () => client,
          makeScoreboardSubscriber: () => client,
          quit: noop,
          scoreboardPrefix: noop
        }
      }
      if (name === './media/mediaContext')
        return {
          FeedHolder: function FeedHolder() {
            return {}
          }
        }
      if (name === './routes/chatEpochs')
        return {
          chatEpochRoutes: (
            db: unknown,
            now: () => Date,
            options: { freshEpochsEnabled: () => boolean }
          ) => {
            expect(db).equals(database)
            flag = options.freshEpochsEnabled
            clock = now
            return mounted
          }
        }
      return services
    }
    const source = transform(readFileSync(file, 'utf8'), {
      transforms: ['typescript', 'imports'],
      filePath: file,
      sourceMapOptions: { compiledFilename: file }
    })
    const code =
      source.code +
      '\n//# sourceMappingURL=data:application/json;base64,' +
      Buffer.from(JSON.stringify(source.sourceMap)).toString('base64')
    expect(() => {
      isolated._compile(code, file)
    }).throws(stop.message)
    expect(clock?.()).instanceOf(Date)
    expect(flag?.()).equals(false)
    config.chatHistoryRecoveryEnabled = true
    expect(flag?.()).equals(true)
  })
  it('compiles history cursor queries without opening a connection', async () => {
    const db = makeDatabase('postgres://invalid.example.test/unreachable')
    const query = db
      .selectFrom('chat_epoch_boxes')
      .select('delivery_seq')
      .where('delivery_seq', '>', '9007199254740993')
      .compile()
    expect(query.parameters).deep.equals(['9007199254740993'])
    await db.destroy()
  })
})
