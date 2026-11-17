import { expect } from 'chai'

import {
  answered,
  byLabel,
  byLabelStart,
  named,
  openSearch,
  pathname,
  searchSpec,
  searchWorld,
  typeSearch,
  within
} from '../../../rigs/search/searchRig'

/** Tapping a row opens its league's, season's, team's or player's page. */
export default searchSpec({
  id: 'app-shell/search/open',
  title: 'A search result opens its own league, season, team or player page',
  covers: [
    'src/app/screens/SearchScreen.tsx',
    'src/app/components/SearchResultRow.tsx',
    'src/app/App.tsx'
  ],
  minutes: 4,
  scenarios: {
    'each-kind': async ctx => {
      const { world, web, tag, frames } = await searchWorld(ctx, 'coach')
      const rows: Array<[string, string, string]> = [
        [
          'league',
          byLabel(`Open ${named(world, 'Hawks League')}`),
          `/groups/league/${world.ids.league}`
        ],
        [
          'season',
          byLabel(`Open ${named(world, 'Hawks Spring 2026')}`),
          `/groups/season/${world.ids.season}`
        ],
        [
          'team',
          byLabel(`Open ${named(world, 'Ridge Hawks')}`),
          `/groups/team/${world.ids.followableTeam}`
        ],
        [
          'person',
          byLabelStart('Open LaTroy'),
          `/players/${world.accounts.hawk.userId}`
        ]
      ]
      for (const [kind, row, path] of rows) {
        await openSearch(ctx, web)
        await typeSearch(web, `hawk ${tag}`)
        // The answer to the whole query, so the row is not re-rendered under
        // the tap.
        await answered(web, frames, `hawk ${tag}`)
        await web.m.tapOn({ css: row, timeout: 15000 })
        await ctx.checkpoint(`opens-${kind}`, {
          readBack: async () => {
            await within(15000, async () => {
              expect(await pathname(web), `the ${kind}’s page`).equals(path)
            })
          }
        })
      }
    }
  }
})
