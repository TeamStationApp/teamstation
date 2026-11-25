import { expect } from 'chai'
import { describe, it } from 'mocha'

import { parseRoute, type Route, routePath } from '../navigation/routes'

describe('the sponsor features addresses', () => {
  it('round-trips each sponsor screen’s address', () => {
    const routes: Route[] = [{ name: 'sponsorLogos', id: 'lea_demo' }]
    for (const route of routes)
      expect(parseRoute(routePath(route), '')).deep.equals(route)
    expect(routePath({ name: 'sponsorLogos', id: 'lea demo' })).equals(
      '/groups/league/lea%20demo/sponsors/logos'
    )
    expect(
      parseRoute('/groups/league/lea%20demo/sponsors/logos', '')
    ).deep.equals({
      name: 'sponsorLogos',
      id: 'lea demo'
    })
  })

  it('leaves the league’s other addresses as they were', () => {
    expect(parseRoute('/groups/league/x/umpires', '')).deep.equals({
      name: 'leagueUmpires',
      id: 'x'
    })
    expect(parseRoute('/groups/league/x/sponsors/unknown', '').name).not.equals(
      'sponsorLogos'
    )
  })
})
