import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { find, mount, press, unmount } from '../../test/gameFormDom'
import { PagedListEnd } from './PagedListEnd'

describe('PagedListEnd', function () {
  afterEach(unmount)

  it('shows nothing with nothing on its way', async function () {
    await mount(
      <PagedListEnd
        list={{
          loadingMore: false,
          failed: false,
          retry: async () => undefined
        }}
      />
    )
    expect(document.body.textContent).equals('')
  })

  it('shows a spinner while the next page is on its way', async function () {
    await mount(
      <PagedListEnd
        list={{
          loadingMore: true,
          failed: false,
          retry: async () => undefined
        }}
      />
    )
    expect(document.querySelector('[aria-label="Loading"]')).not.equals(null)
  })

  it('offers Retry for a page it could not read', async function () {
    let retried = 0
    await mount(
      <PagedListEnd
        list={{
          loadingMore: false,
          failed: true,
          retry: async () => {
            retried++
          }
        }}
      />
    )
    expect(document.body.textContent).includes('Could not load more')
    expect(find('Retry')).not.equals(undefined)
    await press('Retry')
    expect(retried).equals(1)
  })
})
