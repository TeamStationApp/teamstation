import { expect } from 'chai'

import type { WebSession } from '../../../core/spec'
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
  'src/server/location/places.ts',
  'src/server/location/ipPlaces.ts'
]

/** The suggested place pills, in order. */
async function placePills(web: WebSession): Promise<string[]> {
  return (await web.page.evaluate(
    `[...document.querySelectorAll('[data-testid="location-suggestions"] [data-testid="location-pill"]')].map(node => node.textContent)`
  )) as string[]
}

/**
 * Location pills: a city pill puts the city's organizations first and then
 * widens to the nearest, a state pill only filters, a chosen pill hides
 * people, Backspace in the empty field takes the pill out, and places that
 * match as well are suggested nearest the reader first.
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
    },

    'near-reader': async ctx => {
      // The coach's own team and league are in San Diego.
      const { web } = await searchWorld(ctx, 'coach')
      await openSearch(ctx, web)
      await typeSearch(web, 'teme')
      await ctx.checkpoint('temecula-first', {
        expect: [{ text: exactly('Choose Temecula, CA') }],
        readBack: async () => {
          await within(10000, async () => {
            expect(
              (await placePills(web))[0],
              'the place near the coach first'
            ).equals('Temecula, CA')
          })
        }
      })
      await proveScreen(ctx, web, 'search-teme-near-reader.png')

      // Signed out, on a stack with no IP database, nothing places the
      // reader: the pills keep the order a match gives them.
      const { web: signedOut } = await searchWorld(ctx, null)
      await openSearch(ctx, signedOut)
      await typeSearch(signedOut, 'teme')
      await ctx.checkpoint('signed-out-by-match', {
        expect: [{ text: 'Choose Teme.*' }],
        readBack: async () => {
          await within(10000, async () => {
            const pills = await placePills(signedOut)
            expect(pills.length, 'pills shown').greaterThan(0)
            expect(pills[0]).not.equals('Temecula, CA')
          })
        }
      })
    },

    'backspace-removes': async ctx => {
      const { web } = await searchWorld(ctx, 'coach')
      await openSearch(ctx, web)
      await typeSearch(web, 'san die')
      await web.m.tapOn({
        css: byLabel('Choose San Diego, CA'),
        timeout: 15000
      })
      await typeSearch(web, 'x')
      await web.m.pressKey({ key: 'Backspace' })
      await ctx.checkpoint('text-deleted-pill-kept', {
        expect: [{ text: exactly('Remove San Diego, CA') }],
        readBack: async () => {
          expect(await fieldText(web), 'the x is deleted').equals('')
        }
      })
      await web.m.pressKey({ key: 'Backspace' })
      await ctx.checkpoint('pill-removed-by-backspace', {
        expect: [{ text: exactly('Remove San Diego, CA'), absent: true }],
        readBack: async () => {
          await within(5000, async () => {
            expect(
              await readRows(web),
              'an empty field with no place shows nothing'
            ).deep.equals([])
          })
        }
      })
    }
  }
})
