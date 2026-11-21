import { expect } from 'chai'

import {
  answered,
  apiClient,
  exactly,
  jevOf,
  openSearch,
  proveLog,
  searchSpec,
  searchWorld,
  serverLogCount,
  typeSearch,
  within
} from '../../../rigs/search/searchRig'

/**
 * TypeSafe's real Jev ranks a search: the stack keeps its `jev.baseUrl` on
 * the stand-in, which passes the request through with the real key the
 * node administrator set.
 */
export default searchSpec({
  id: 'app-shell/search/live-jev',
  title: 'The real Jev model ranks a search and names its model',
  covers: ['src/server/search/jev.ts', 'src/server/search/socket.ts'],
  minutes: 3,
  secrets: ['jev'],
  scenarios: {
    'real-ranking': async ctx => {
      const { world, web, frames } = await searchWorld(ctx, 'coach')
      const jev = jevOf(ctx)
      const admin = await apiClient(ctx, world.accounts.nodeAdmin)
      const key = ctx.secret('jev')
      await admin.setJevKey(key)
      try {
        await jev.set({ passThrough: true })
        await openSearch(ctx, web)
        await typeSearch(web, 'san diego')
        const ranked = await within(15000, async () => {
          const seen = (await jev.read()).requests.filter(
            row => row.query === 'san diego' && row.passedThrough
          )
          if (seen.length === 0) throw new Error('Jev not asked yet')
          return seen[seen.length - 1]
        })
        expect(ranked.status, 'TypeSafe answered through the stand-in').equals(
          200
        )
        // Jev's answer to the whole query reached the page.
        const { rows } = await answered(web, frames, 'san diego', {
          stage: 'jev',
          timeoutMs: 15000
        })
        const logged = await serverLogCount(
          ctx,
          `jev: ranked by ${ranked.model ?? ''}`
        )
        proveLog(
          ctx,
          'jev-live.log',
          [
            `query: san diego`,
            `status: ${ranked.status}`,
            `model: ${ranked.model ?? '(none)'}`,
            `latency: ${ranked.latencyMs} ms`,
            `candidates ranked: ${ranked.candidates}`,
            `rows shown: ${rows.length}`,
            `answers the page received, by stage: ${frames.stages().join(', ')}`,
            `server log lines naming the model: ${logged ?? 'not readable'}`,
            ''
          ].join('\n')
        )
        if (logged == null) ctx.degrade('the stack’s API log could not be read')
        await ctx.checkpoint('real-jev', {
          expect: [
            { text: exactly('Search needs a connection.'), absent: true }
          ],
          readBack: async () => {
            expect(ranked.status, 'TypeSafe answered').equals(200)
            expect(ranked.model, 'the answer names its model').matches(/\S/)
            expect(ranked.candidates).greaterThan(0)
            expect(rows.length).greaterThan(0)
            if (logged != null)
              expect(logged, 'the API logged the model').greaterThan(0)
            // The key is the request's own, never the stand-in's record.
            expect(JSON.stringify(await jev.read())).not.includes(key)
          }
        })
      } finally {
        await jev.set({})
        await admin.clearJevKey()
      }
    }
  }
})
