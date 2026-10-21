import { expect } from 'chai'
import { it } from 'mocha'

import { parseRoute, type Route, routePath } from '../navigation/routes'
it('round-trips every management screen and preserves schedule filters in the URL', () => {
  const routes: Route[] = [
    { name: 'leagueUmpires', id: 'demo' },
    { name: 'umpireLevels', id: 'demo' },
    { name: 'umpireRequirements', id: 'demo' },
    {
      name: 'umpireRequirementEdit',
      id: 'demo',
      seasonIds: ['spring', 'fall']
    },
    {
      name: 'umpireSchedule',
      id: 'demo',
      pill: 'leaderboard',
      view: 'league',
      levels: 'majors,minors',
      days: '0,6',
      from: '09:00',
      to: '18:00'
    }
  ]
  for (const route of routes) {
    const path = routePath(route)
    const url = new URL(path, 'http://example.test')
    expect(parseRoute(url.pathname, url.search)).deep.equals(route)
  }
  expect(parseRoute('/umpires/demo')).deep.equals({
    name: 'umpireSchedule',
    id: 'demo',
    pill: 'schedule',
    view: 'umpire'
  })
  expect(
    parseRoute('/groups/league/demo/umpire-requirements/edit')
  ).deep.equals({
    name: 'umpireRequirementEdit',
    id: 'demo',
    seasonIds: []
  })
  expect(routePath({ name: 'umpireSchedule', id: 'demo' })).equals(
    '/umpires/demo'
  )
})
