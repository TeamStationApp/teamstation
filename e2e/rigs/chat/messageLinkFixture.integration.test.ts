import { expect } from 'chai'
import { describe, it } from 'mocha'

import { destinationPage } from './messageLinkFixture'

describe('chat link destination', function () {
  it('uses the configured HTTPS site without allocating a local port', async function () {
    const origin = 'https://fixture.example.test'
    const destination = await destinationPage({ destinationOrigin: origin })
    expect(destination.origin).to.equal(origin)
    expect(destination.port).to.equal(undefined)
    destination.close()
  })

  it('serves the in-browser address on the local test port', async function () {
    const destination = await destinationPage()
    try {
      expect(destination.port).to.be.greaterThan(0)
      const response = await fetch(destination.origin + '/score/example')
      expect(await response.text()).to.include('location.hash')
    } finally {
      destination.close()
    }
  })
})
