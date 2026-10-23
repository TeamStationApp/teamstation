import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { parseRoute, type Route, routePath } from '../../app/navigation/routes'
import { runSitemapCli, SITEMAP_FILE } from './sitemapCli'
import {
  generateSitemap,
  ROUND_TRIP_SAMPLES,
  type Sitemap,
  sitemapDifference,
  type SitemapRoute,
  sitemapText
} from './sitemapGenerator'

/**
 * Tess's sitemap is generated from the code and checked in. These run the
 * generator in memory, so `npm test` fails the moment the checked-in file is
 * stale, and pin what it reads out of the routes, the Shell and the screens.
 */
const ROOT = resolve(__dirname, '../../..')
const ROUTES_FILE = 'src/app/navigation/routes.ts'
const SEASON_FILE = 'src/app/screens/SeasonPresentation.tsx'

function source(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

function routeOf(sitemap: Sitemap, name: string): SitemapRoute {
  const route = sitemap.routes.find(item => item.name === name)
  if (route == null) throw new Error(`No ${name} in the sitemap`)
  return route
}

/** A template with each parameter given a value `parseRoute` accepts. */
function concrete(template: string): { path: string; search: string } {
  const [path, search = ''] = template
    .replace(
      /:([A-Za-z][A-Za-z.]*)/g,
      (_, name: string) => ROUND_TRIP_SAMPLES[name] ?? 'abc123'
    )
    .split('?')
  return { path, search }
}

describe('Tess sitemap', function () {
  this.timeout(60000)
  let sitemap: Sitemap
  let scratch: string

  before(function () {
    sitemap = generateSitemap()
    scratch = mkdtempSync(join(tmpdir(), 'tess-sitemap-'))
  })

  after(function () {
    rmSync(scratch, { recursive: true, force: true })
  })

  it('the checked-in file is what the code gives', function () {
    const difference = sitemapDifference(
      sitemap,
      readFileSync(SITEMAP_FILE, 'utf8')
    )
    expect(difference, 'run npm run tess.sitemap and commit the result').equals(
      undefined
    )
  })

  it('lists a season’s date-range screen as a settings page, with its seasons', function () {
    const page = sitemap.routes.find(route => route.name === 'seasonTimeFrame')
    expect(page?.path).equals('/groups/season/:id/settings/time-frame')
    expect(page?.settings).to.include.members([
      'Set date range',
      'Winter',
      'Spring',
      'Summer',
      'Fall',
      'Custom',
      'Save'
    ])
    // Its picker left season settings with it.
    expect(
      sitemap.routes.find(route => route.name === 'groupSettings')?.settings
    ).not.include('Use this range')
  })

  it('has one route for every member of Route', function () {
    // Every member has a case in routePath's exhaustive switch.
    const writer = source(ROUTES_FILE).split('export function routePath')[1]
    const cases = [...writer.matchAll(/case '(\w+)':/g)].map(match => match[1])
    expect(sitemap.routes.map(route => route.name)).deep.equals(
      [...new Set(cases)].sort()
    )
  })

  it('writes each required parameter as :name, never encoded', function () {
    for (const route of sitemap.routes) {
      expect(route.path, route.name).match(/^\//)
      expect(route.path, route.name).not.include('%3A')
      expect(route.path, route.name).not.include('zzz')
    }
    expect(routeOf(sitemap, 'umpireRequirementEdit').path).equals(
      '/groups/league/:id/umpire-requirements/edit?seasons=:seasonIds'
    )
    expect(routeOf(sitemap, 'leagueUmpires').path).equals(
      '/groups/league/:id/umpires'
    )
    expect(routeOf(sitemap, 'team').path).equals('/teams/:teamId')
    expect(routeOf(sitemap, 'game').path).equals('/games/:gameId')
    expect(routeOf(sitemap, 'home').path).equals('/')
  })

  it('every template opens its own route', function () {
    for (const route of sitemap.routes) {
      const { path, search } = concrete(route.path)
      expect(parseRoute(path, search).name, route.path).equals(route.name)
    }
  })

  it('round-trips player and person with a canonical user id', function () {
    const userId = ROUND_TRIP_SAMPLES.userId
    const player = concrete(routeOf(sitemap, 'player').path)
    expect(parseRoute(player.path, player.search)).deep.equals({
      name: 'player',
      userId
    })
    const person = concrete(routeOf(sitemap, 'person').path)
    expect(parseRoute(person.path, person.search)).deep.equals({
      name: 'person',
      kind: 'league',
      id: 'abc123',
      userId
    })
  })

  it('gives the game its section tabs and none of its actions', function () {
    expect(
      routeOf(sitemap, 'game').tabs.map(tab => [tab.param, tab.id, tab.label])
    ).deep.equals([
      ['tab', 'info', 'Info'],
      ['tab', 'boxScore', 'Box score'],
      ['tab', 'watch', 'Videos']
    ])
  })

  it("gives the team TeamScreen's tabs, Videos at the bare address", function () {
    expect(
      routeOf(sitemap, 'team').tabs.map(tab => [tab.label, tab.path])
    ).deep.equals([
      ['Videos', '/teams/:teamId'],
      ['Schedule', '/teams/:teamId?tab=schedule'],
      ['Team', '/teams/:teamId?tab=team'],
      ['Stats', '/teams/:teamId?tab=stats']
    ])
  })

  it('drops the exhibition filter, which is not a tab', function () {
    for (const route of sitemap.routes)
      for (const tab of route.tabs) {
        expect(tab.id, route.name).not.equal('inSeason')
        expect(tab.label, route.name).not.equal('Include Exhibitions')
      }
  })

  it('places the season tabs, its people and its when filters', function () {
    const tabs = routeOf(sitemap, 'season').tabs
    expect(
      tabs.filter(tab => tab.param === 'tab').map(tab => tab.id)
    ).deep.equals([
      'standings',
      'schedule',
      'stats',
      'videos',
      'teams',
      'people'
    ])
    expect(tabs.find(tab => tab.id === 'people')).deep.equals({
      param: 'tab',
      id: 'people',
      label: 'People',
      path: '/seasons/:seasonId?tab=people'
    })
    expect(
      tabs.filter(tab => tab.param === 'when').map(tab => [tab.id, tab.path])
    ).deep.equals([
      ['past', '/seasons/:seasonId'],
      ['upcoming', '/seasons/:seasonId?when=upcoming'],
      ['all', '/seasons/:seasonId?when=all']
    ])
  })

  it("reads the season's people tab from PEOPLE_TAB", function () {
    const text = source(SEASON_FILE)
    const renamed = text.replace(
      "const PEOPLE_TAB = { id: 'people' as const, label: 'People' }",
      "const PEOPLE_TAB = { id: 'people' as const, label: 'Everybody' }"
    )
    expect(renamed).not.equal(text)
    const changed = generateSitemap({ sources: { [SEASON_FILE]: renamed } })
    expect(
      routeOf(changed, 'season').tabs.find(tab => tab.id === 'people')?.label
    ).equals('Everybody')
  })

  it('gives the player its tabs, Walk-up from WALKUP_TAB', function () {
    expect(
      routeOf(sitemap, 'player').tabs.map(tab => [tab.id, tab.label])
    ).deep.equals([
      ['videos', 'Videos'],
      ['stats', 'Stats'],
      ['walkup', 'Walk-up'],
      ['teams', 'Teams']
    ])
    const settings = routeOf(sitemap, 'player').settings
    expect(settings).include.members(['Jersey number', 'No walk-up song yet'])
  })

  it('lists what the group settings pages change', function () {
    expect(routeOf(sitemap, 'groupSettings').settings).include.members([
      'Add Person to …',
      'Create Invite Link',
      'Location not set',
      'Time frame'
    ])
    expect(routeOf(sitemap, 'groupAddPeople').settings).include.members([
      'Add People',
      'E-mail addresses'
    ])
    expect(routeOf(sitemap, 'groupLocation').settings).include.members([
      'City',
      'Start typing a city'
    ])
    // A page that changes nothing has nothing listed.
    expect(routeOf(sitemap, 'team').settings).deep.equals([])
  })

  it('titles a route from the Shell, or from its name', function () {
    expect(routeOf(sitemap, 'home').title).equals('Your Home')
    expect(routeOf(sitemap, 'account').title).equals('Account')
    expect(routeOf(sitemap, 'notification').title).equals('Notifications')
    expect(routeOf(sitemap, 'umpireRequirementEdit').title).equals(
      'Umpire requirement edit'
    )
  })

  it('is sorted, stable and under 120 KB', function () {
    const names = sitemap.routes.map(route => route.name)
    expect(names).deep.equals([...names].sort())
    const text = sitemapText(sitemap)
    expect(sitemapText(generateSitemap())).equals(text)
    expect(Buffer.byteLength(text)).below(120 * 1024)
  })

  describe('when the code cannot be mapped', function () {
    const routes = source(ROUTES_FILE)
    const withMember = (member: string): string => {
      const changed = routes.replace(
        "  | { name: 'home' }\n",
        `  | { name: 'home' }\n  | ${member}\n`
      )
      expect(changed).not.equal(routes)
      return changed
    }

    it('fills numbers, booleans, lists and required objects', function () {
      const sample = generateSitemap({
        sources: {
          [ROUTES_FILE]: withMember(
            "{ name: 'zzSample'; count: number; on: boolean; ids: string[]; ref: { kind: 'b' | 'a'; id: string; note?: string } }"
          )
        },
        routePath: route => {
          if (route.name !== ('zzSample' as Route['name']))
            return routePath(route)
          const filled = route as unknown as {
            count: number
            on: boolean
            ids: string[]
            ref: { kind: string; id: string }
          }
          return `/sample/${filled.count}/${filled.on}/${filled.ids.join(',')}/${filled.ref.kind}/${filled.ref.id}`
        },
        parseRoute: (path, search) =>
          path.startsWith('/sample/')
            ? ({ name: 'zzSample' } as unknown as Route)
            : parseRoute(path, search)
      })
      expect(routeOf(sample, 'zzSample').path).equals(
        '/sample/0/false/:ids/b/:ref.id'
      )
    })

    it('names a member whose property it cannot fill', function () {
      expect(() =>
        generateSitemap({
          sources: {
            [ROUTES_FILE]: withMember("{ name: 'zzBad'; big: bigint }")
          }
        })
      ).throws(/Route zzBad: cannot fill big \(bigint\)/)
    })

    it('names a member without a name', function () {
      expect(() =>
        generateSitemap({
          sources: { [ROUTES_FILE]: withMember('{ title: string }') }
        })
      ).throws(/A Route member has no name/)
    })

    it('names a route whose address opens another', function () {
      expect(() =>
        generateSitemap({
          parseRoute: (path, search) =>
            path.startsWith('/teams/')
              ? { name: 'home' }
              : parseRoute(path, search)
        })
      ).throws(/Route team: \/teams\/:teamId parses back as home/)
    })

    it('names a route routePath cannot write', function () {
      expect(() =>
        generateSitemap({
          routePath: route => {
            if (route.name === 'venue') throw new Error('no venue')
            return routePath(route)
          }
        })
      ).throws(/Route venue: routePath failed: Error: no venue/)
      expect(() =>
        generateSitemap({
          routePath: route =>
            route.name === 'venue'
              ? (undefined as unknown as string)
              : routePath(route)
        })
      ).throws(/Route venue: routePath gave no address/)
    })

    it('needs the Route type and the Shell', function () {
      expect(() =>
        generateSitemap({ sources: { [ROUTES_FILE]: 'export {}' } })
      ).throws(/No Route type/)
      expect(() =>
        generateSitemap({ sources: { 'src/app/App.tsx': 'export {}' } })
      ).throws(/No renderFrame chain/)
      // Not a function, or a block with no return of its own.
      for (const source of [
        'const renderFrame = 1',
        'const renderFrame = (top: unknown) => { if (top) return 1 }'
      ])
        expect(() =>
          generateSitemap({ sources: { 'src/app/App.tsx': source } })
        ).throws(/No renderFrame chain/)
      // An arrow's expression body is the chain itself.
      expect(() =>
        generateSitemap({
          sources: { 'src/app/App.tsx': 'const renderFrame = () => null' }
        })
      ).not.throws(/No renderFrame chain/)
      expect(() => generateSitemap({ root: scratch })).throws(
        /No src\/app\/App.tsx/
      )
    })
  })

  describe('sitemapDifference', function () {
    const one = (name: string, path = '/'): SitemapRoute => ({
      name,
      path,
      title: name,
      tabs: [],
      settings: []
    })
    const fresh: Sitemap = { routes: [one('a'), one('b')] }

    it('names the first route that differs', function () {
      expect(sitemapDifference(fresh, sitemapText(fresh))).equals(undefined)
      expect(sitemapDifference(fresh, 'not json')).equals(
        'the checked-in sitemap is not JSON'
      )
      expect(
        sitemapDifference(fresh, sitemapText({ routes: [one('a')] }))
      ).equals('route b is missing')
      expect(
        sitemapDifference(
          fresh,
          sitemapText({ routes: [one('a'), one('aa'), one('b')] })
        )
      ).equals('route aa is no longer in the app')
      expect(
        sitemapDifference(
          fresh,
          sitemapText({ routes: [one('a', '/x'), one('b')] })
        )
      ).equals('route a differs')
      expect(sitemapDifference(fresh, JSON.stringify(fresh))).equals(
        'the routes match but the file is not formatted as generated'
      )
      expect(sitemapDifference(fresh, '{}')).equals('route a is missing')
    })
  })

  describe('npm run tess.sitemap', function () {
    const lines: string[] = []
    const io = {
      print: (line: string) => {
        lines.push(line)
      },
      generate: () => sitemap
    }

    it('writes the file, then checks it', function () {
      const file = join(scratch, 'written.json')
      lines.length = 0
      expect(runSitemapCli(['--file', file], io)).equals(0)
      expect(readFileSync(file, 'utf8')).equals(sitemapText(sitemap))
      expect(lines[0]).match(/^Wrote .*written\.json: \d+ routes, \d+ bytes$/)
      expect(runSitemapCli(['--check', '--file', file], io)).equals(0)
      expect(lines[1]).match(/written\.json is up to date: \d+ routes$/)
    })

    it('fails --check on a stale or missing file', function () {
      const file = join(scratch, 'stale.json')
      writeFileSync(
        file,
        sitemapText({
          routes: sitemap.routes.map(route =>
            route.name === 'team' ? { ...route, tabs: [] } : route
          )
        })
      )
      lines.length = 0
      expect(runSitemapCli(['--check', '--file', file], io)).equals(1)
      expect(lines[0]).match(
        /stale\.json is stale: route team differs\. Run npm run tess\.sitemap$/
      )
      expect(
        runSitemapCli(['--check', '--file', join(scratch, 'none.json')], io)
      ).equals(1)
      expect(lines[1]).match(/none\.json is missing/)
    })

    it('refuses an argument it does not know', function () {
      lines.length = 0
      expect(runSitemapCli(['--file'], io)).equals(2)
      expect(runSitemapCli(['--fix'], io)).equals(2)
      expect(lines).include('Unknown argument --fix')
    })

    it('exits 1 from the command line on a stale copy', function () {
      const file = join(scratch, 'stale-cli.json')
      writeFileSync(file, sitemapText({ routes: sitemap.routes.slice(1) }))
      const run = spawnSync(
        process.execPath,
        [
          '-r',
          'sucrase/register',
          'src/server/tess/sitemapCli.ts',
          '--check',
          '--file',
          file
        ],
        { cwd: ROOT, encoding: 'utf8' }
      )
      expect(run.status, run.stderr).equals(1)
      expect(run.stdout).match(
        new RegExp(`route ${sitemap.routes[0].name} is missing`)
      )
    })
  })
})
