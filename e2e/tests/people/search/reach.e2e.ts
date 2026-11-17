import { expect } from 'chai'

import {
  answered,
  clearSearch,
  exactly,
  named,
  openSearch,
  ownRows,
  rowKind,
  searchSpec,
  searchWorld,
  typeSearch
} from '../../../rigs/search/searchRig'

const NOTHING = 'Nothing matches.'

/**
 * Search finds people only inside the reader's own teams, seasons and
 * leagues, by the name the reader is shown, and nobody at all signed out.
 */
export default searchSpec({
  id: 'people/search/reach',
  title:
    'Search finds people only in the reader’s groups, by the name they are shown, and nobody signed out',
  covers: [
    'src/server/search/reach.ts',
    'src/server/search/gather.ts',
    'src/server/search/socket.ts',
    'src/app/screens/SearchScreen.tsx'
  ],
  minutes: 4,
  scenarios: {
    'people-in-groups-only': async ctx => {
      const { web, frames } = await searchWorld(ctx, 'guardian')
      await openSearch(ctx, web)
      // Each check reads the answer to the whole typed text: a prefix such
      // as "Free" finds Freddie F, whom "Freeman" alone must not.
      const search = async (text: string): Promise<void> => {
        await typeSearch(web, text)
        await answered(web, frames, text)
      }
      // A player on the child's team, shown as the team writes names.
      await search('Freddie')
      await ctx.checkpoint('teammate-found', {
        expect: [{ text: exactly('Open Freddie F') }]
      })
      // Only in another league: nobody, even by the whole name.
      await clearSearch(web)
      await search('Yoshinobu Yamamoto')
      await ctx.checkpoint('other-league-not-found', {
        expect: [
          { text: exactly(NOTHING) },
          { text: 'Open Yoshinobu.*', absent: true }
        ]
      })
      // The surname the team hides finds nobody alone.
      await clearSearch(web)
      await search('Freeman')
      await ctx.checkpoint('hidden-surname-alone', {
        expect: [
          { text: exactly(NOTHING) },
          { text: 'Open Freddie.*', absent: true }
        ]
      })
      // Both names typed whole find him, still shown shortened.
      await clearSearch(web)
      await search('Freddie Freeman')
      await ctx.checkpoint('full-name-found', {
        expect: [
          { text: exactly('Open Freddie F') },
          { text: exactly('Open Freddie Freeman'), absent: true }
        ]
      })
    },

    'signed-out': async ctx => {
      const { world, web, tag, frames } = await searchWorld(ctx, null)
      await openSearch(ctx, web)
      await typeSearch(web, `hawk ${tag}`)
      const { rows } = await answered(web, frames, `hawk ${tag}`, {
        ready: shown => {
          if (ownRows(shown, tag).length === 0) throw new Error('not yet')
        }
      })
      const ridge = named(world, 'Ridge Hawks')
      await ctx.checkpoint('organizations-only', {
        expect: [
          { text: exactly(`Open ${ridge}`) },
          { text: exactly(`Follow ${ridge}`), absent: true },
          { text: 'Open LaTroy.*', absent: true }
        ],
        readBack: async () => {
          expect(
            rows.filter(row => row.follow != null),
            'no Follow'
          ).deep.equals([])
          expect(
            rows.some(row => rowKind(row) === 'Person'),
            'no people'
          ).equals(false)
        }
      })
      await clearSearch(web)
      await typeSearch(web, 'LaTroy Hawkins')
      await answered(web, frames, 'LaTroy Hawkins')
      await ctx.checkpoint('player-not-found', {
        expect: [
          { text: exactly(NOTHING) },
          { text: 'Open LaTroy.*', absent: true }
        ]
      })
    }
  }
})
