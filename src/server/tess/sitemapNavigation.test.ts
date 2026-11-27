import { expect } from 'chai'
import { describe, it } from 'mocha'

import { generateSitemap } from './sitemapGenerator'

describe('the Schedule tab in the Tess sitemap', function () {
  it('keeps the upcoming, past and all filters addressable', function () {
    const schedule = generateSitemap().routes.find(
      route => route.name === 'schedule'
    )
    expect(schedule?.tabs.map(({ id, path }) => [id, path])).deep.equals([
      ['upcoming', '/schedule'],
      ['past', '/schedule?when=past'],
      ['all', '/schedule?when=all']
    ])
  })
})
