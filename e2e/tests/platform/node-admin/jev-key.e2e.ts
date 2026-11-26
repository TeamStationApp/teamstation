import { randomBytes } from 'node:crypto'

import { expect } from 'chai'

import {
  answered,
  apiClient,
  byLabel,
  exactly,
  jevOf,
  openSearch,
  proveScreen,
  searchSpec,
  searchWorld,
  serverLogCount,
  typeSearch
} from '../../../rigs/search/searchRig'

const KEY_FIELD = 'Jev API key'

/**
 * The node administrator sets and removes the Jev key on Node
 * Administration. The key is never read back, by a route or in the log,
 * and with none set search ranks without Jev.
 */
export default searchSpec({
  id: 'platform/node-admin/jev-key',
  title:
    'The node administrator sets and removes the Jev key, which no route or log shows',
  covers: [
    'src/app/screens/NodeSettingsCard.tsx',
    'src/server/nodeSettings.ts',
    'src/server/routes/nodeAdministration.ts'
  ],
  minutes: 4,
  scenarios: {
    'set-and-clear': async ctx => {
      const { world, web, tag, frames } = await searchWorld(ctx, 'nodeAdmin')
      const m = web.m
      const admin = await apiClient(ctx, world.accounts.nodeAdmin)
      // The world set a placeholder: the screen starts with none.
      await admin.clearJevKey()
      const key = `e2e-jev-${randomBytes(12).toString('hex')}`

      await m.openLink({ link: `${ctx.stack.origin}/node` })
      // The card is longer than ten scrolls since the sponsor settings: bring
      // the key's field near first, once the card has loaded.
      await m.assertVisible({ text: 'Show for games from', timeout: 60000 })
      await m.evalBrowserScript({
        script: `const field = document.querySelector('${byLabel(KEY_FIELD)}')
          if (field != null) field.scrollIntoView({ block: 'center' })`
      })
      await m.scrollUntilVisible({
        element: { text: KEY_FIELD },
        centerElement: true,
        timeout: 60000
      })
      await ctx.checkpoint('no-key', {
        expect: [
          {
            text: exactly(
              'No key is set. Search ranks its results by how well the names match.'
            )
          },
          { text: 'Remove', absent: true }
        ]
      })
      await m.tapOn({ css: byLabel(KEY_FIELD), timeout: 15000 })
      await m.inputText({ text: key })
      await m.tapOn({ text: 'Set', timeout: 15000 })
      await ctx.checkpoint('key-set', {
        expect: [{ text: 'Replace' }, { text: 'Remove' }],
        readBack: async () => {
          const settings = await admin.nodeSettings()
          expect(settings.jev).deep.equals({ configured: true })
          expect(
            JSON.stringify(settings),
            'the key is never read back'
          ).not.includes(key)
          const logged = await serverLogCount(ctx, key)
          if (logged == null)
            ctx.degrade('the stack’s API log could not be read')
          else expect(logged, 'the key is never logged').equals(0)
        }
      })
      await proveScreen(ctx, web, 'node-admin-after.png')

      await m.tapOn({ text: 'Remove', timeout: 15000 })
      await ctx.checkpoint('key-removed', {
        expect: [{ text: 'Set' }, { text: 'Remove', absent: true }],
        readBack: async () => {
          expect((await admin.nodeSettings()).jev).deep.equals({
            configured: false
          })
        }
      })

      // With no key, search answers by the names alone and asks Jev nothing.
      const jev = jevOf(ctx)
      await jev.set({})
      await openSearch(ctx, web)
      await typeSearch(web, `hawk ${tag}`)
      await answered(web, frames, `hawk ${tag}`, {
        ready: rows => {
          expect(rows.length).greaterThan(0)
        }
      })
      await new Promise(resolve => setTimeout(resolve, 2500))
      await ctx.checkpoint('lexicographic-only', {
        readBack: async () => {
          expect((await jev.read()).requests, 'Jev not asked').deep.equals([])
        }
      })
    }
  }
})
