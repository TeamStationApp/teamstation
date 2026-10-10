import { resolve } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { TeamStationClient } from '../../common/api'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { publishPictureCatalog } from '../media/pictureCatalog'
import { locationRoutes } from './location'
import { pictureRoutes } from './pictures'

describe('picture catalog HTTP contract', function () {
  this.timeout(60000)
  let h: AccountHarness
  before(async () => {
    h = await accountHarness(undefined, (app, { db, space }) => {
      app.use('/api/v1', locationRoutes())
      app.use(
        '/api/v1/unavailable',
        pictureRoutes(db, {
          endpoint: 'http://localhost',
          bucket: 'test',
          region: 'test',
          accessKeyId: '',
          secretAccessKey: ''
        })
      )
      app.use('/api/v1', pictureRoutes(db, space))
    })
  })
  after(async () => {
    await h?.close()
  })
  it('exposes shared choices but only mutates the authenticated account', async () => {
    const unseeded = await h.request('GET', '/pictures', undefined, null)
    expect(unseeded.status).equals(503)
    expect(await unseeded.text()).includes('Retry')
    await publishPictureCatalog(h.space, resolve('src/app/assets/sports'))
    const catalog = await h.request('GET', '/pictures', undefined, null)
    expect(catalog.status).equals(200)
    expect(((await catalog.json()) as { entries: unknown[] }).entries).length(
      31
    )
    expect(
      (
        await h.request('PUT', '/me/account/catalog-picture', {
          catalogId: 'baseball'
        })
      ).status
    ).equals(200)
    expect(
      (
        await h.request('PUT', '/me/account/catalog-picture', {
          catalogId: 'foreign'
        })
      ).status
    ).equals(400)
    expect(
      (
        await h.request(
          'PUT',
          '/me/account/catalog-picture',
          { catalogId: 'baseball' },
          null
        )
      ).status
    ).equals(401)
    const client = new TeamStationClient({
      baseUrl: h.origin + '/api/v1',
      token: h.tokens.get(101)
    })
    expect(await client.pictures()).length(31)
    await client.chooseCatalogPicture('baseball')
    expect(await client.locations('York')).not.length(0)
    expect(await client.locationSuggestion(0, 0)).not.equals(null)
    expect(
      (await h.request('GET', '/unavailable/pictures', undefined, null)).status
    ).equals(503)
  })
})
