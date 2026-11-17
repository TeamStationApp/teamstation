import { expect } from 'chai'

import {
  answered,
  byLabel,
  clearSearch,
  exactly,
  fieldText,
  named,
  openSearch,
  ownRows,
  proveScreen,
  readRows,
  ringProblems,
  rowCity,
  rowKind,
  rowName,
  searchSpec,
  searchWorld,
  typeSearch,
  within
} from '../../../rigs/search/searchRig'

const COVERS = [
  'src/app/screens/SearchScreen.tsx',
  'src/app/components/LocationPill.tsx',
  'src/server/search/**',
  'src/server/location/places.ts'
]

/**
 * Location pills: a city pill puts the city's organizations first and then
 * widens to the nearest, a state pill only filters, and a chosen pill
 * hides people.
 */
export default searchSpec({
  id: 'app-shell/search/location',
  title:
    'A city pill finds its organizations first and then the nearest; a state pill only filters',
  covers: COVERS,
  minutes: 4,
  scenarios: {
    'city-widens': async ctx => {
      const { world, web, tag, frames } = await searchWorld(ctx, 'coach')
      await openSearch(ctx, web)
      await typeSearch(web, 'san die')
      await web.m.tapOn({
        css: byLabel('Choose San Diego, CA'),
        timeout: 15000
      })
      await ctx.checkpoint('pill-chosen', {
        expect: [{ text: exactly('Remove San Diego, CA') }],
        readBack: async () => {
          expect(await fieldText(web), 'the typed text is gone').equals('')
        }
      })
      // The nonce alone, so the city's rows are only this world's: other
      // search worlds' San Diego rows would otherwise fill each kind inside
      // the city, and the answer would never widen. The rows are read once
      // they answer the whole nonce: a prefix of it can be in another
      // world's nonce too.
      await typeSearch(web, tag)
      const own = named(world, 'Demo Hawks')
      const { rows } = await answered(web, frames, tag, {
        ready: shown => {
          if (ownRows(shown, tag).length < 5) throw new Error('not yet')
        }
      })
      await ctx.checkpoint('city-first-then-nearest', {
        expect: [{ text: exactly(`Open ${own}`) }],
        readBack: async () => {
          expect(
            rows.length,
            'only this world’s organizations match its nonce'
          ).equals(ownRows(rows, tag).length)
          expect(
            ringProblems(rows),
            'San Diego first, then by distance'
          ).deep.equals([])
          // This world's teams: its San Diego one, then the suburbs around
          // it, out as far as El Cajon.
          const cities = rows
            .filter(row => rowKind(row) === 'Team')
            .map(rowCity)
          expect(cities[0], 'a San Diego team first').equals('San Diego, CA')
          expect(cities[1], 'then the cities around it').equals(
            'National City, CA'
          )
          expect(cities, 'widened as far as El Cajon').includes('El Cajon, CA')
        }
      })
      await proveScreen(ctx, web, 'search-location-pill-after.png')

      // A pill hides people: LaTroy Hawkins, whom the coach finds without
      // one, is not found with it.
      await clearSearch(web)
      await typeSearch(web, 'LaTroy Hawkins')
      await answered(web, frames, 'LaTroy Hawkins')
      await ctx.checkpoint('pill-hides-people', {
        expect: [
          { text: exactly('Remove San Diego, CA') },
          { text: exactly('Nothing matches.') },
          { text: 'Open LaTroy.*', absent: true }
        ],
        readBack: async () => {
          expect(
            (await readRows(web)).some(row => rowKind(row) === 'Person'),
            'no people with a pill'
          ).equals(false)
        }
      })

      await clearSearch(web)
      const { rows: cityRows } = await answered(web, frames, '', {
        ready: shown => {
          if (shown.length === 0) throw new Error('no rows yet')
        }
      })
      await ctx.checkpoint('city-without-text', {
        expect: [{ text: exactly('Remove San Diego, CA') }],
        readBack: async () => {
          const rows = cityRows
          expect(rowCity(rows[0]), 'San Diego’s first').equals('San Diego, CA')
          expect(ringProblems(rows)).deep.equals([])
        }
      })

      await web.m.tapOn({
        css: byLabel('Remove San Diego, CA'),
        timeout: 15000
      })
      await ctx.checkpoint('pill-removed', {
        expect: [{ text: exactly('Remove San Diego, CA'), absent: true }],
        readBack: async () => {
          await within(5000, async () => {
            expect(
              await readRows(web),
              'an empty field shows nothing'
            ).deep.equals([])
          })
        }
      })
    },

    'state-filters': async ctx => {
      const { world, web, tag, frames } = await searchWorld(ctx, 'coach')
      await openSearch(ctx, web)
      await typeSearch(web, 'californ')
      await web.m.tapOn({ css: byLabel('Choose California'), timeout: 15000 })
      await typeSearch(web, `hawk ${tag}`)
      const { rows: shownRows } = await answered(web, frames, `hawk ${tag}`, {
        ready: shown => {
          if (ownRows(shown, tag).length < 5) throw new Error('not yet')
        }
      })
      await ctx.checkpoint('california-only', {
        expect: [
          { text: exactly('Remove California') },
          { text: exactly(`Open ${named(world, 'Capital Hawks')}`) },
          {
            text: exactly(`Open ${named(world, 'Desert Hawks')}`),
            absent: true
          }
        ],
        readBack: async () => {
          const rows = ownRows(shownRows, tag)
          const cities = rows.map(rowCity)
          expect(cities, 'nothing outside California').not.includes(
            'Phoenix, AZ'
          )
          expect(cities).includes('Sacramento, CA')
          expect(rows.map(rowName)).not.includes(
            named(world, 'Desert Hawks League')
          )
        }
      })
    }
  }
})
