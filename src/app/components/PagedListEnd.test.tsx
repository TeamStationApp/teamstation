import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React from 'react'

import { find, mount, press, unmount } from '../../test/gameFormDom'
import { PagedListEmpty, PagedListEnd, PagedListStart } from './PagedListEnd'

describe('PagedListEnd', function () {
  afterEach(unmount)

  it('shows nothing with nothing on its way', async function () {
    await mount(
      <PagedListEnd
        list={{
          loadingMore: false,
          failed: false,
          failedWay: undefined,
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
          failedWay: undefined,
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
          failedWay: 'next',
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

  it('offers Retry for an older page at the start, not the end', async function () {
    let retried = 0
    const list = {
      loadingMore: false,
      failed: true,
      failedWay: 'previous' as const,
      retry: async () => {
        retried++
      }
    }
    await mount(
      <>
        <PagedListStart list={list} />
        <PagedListEnd list={list} />
      </>
    )
    const start = document.querySelector(
      '[data-testid="paged-list-start-failed"]'
    )
    expect(start?.textContent).includes('Could not load more')
    expect(
      document.querySelector('[data-testid="paged-list-end-failed"]')
    ).equals(null)
    expect(document.body.textContent?.split('Could not load more')).has.length(
      2
    )
    await press('Retry')
    expect(retried).equals(1)
  })

  it('offers Retry for a later page at the end, not the start', async function () {
    const list = {
      loadingMore: false,
      failed: true,
      failedWay: 'next' as const,
      retry: async () => undefined
    }
    await mount(
      <>
        <PagedListStart list={list} />
        <PagedListEnd list={list} />
      </>
    )
    expect(
      document.querySelector('[data-testid="paged-list-start-failed"]')
    ).equals(null)
    expect(
      document.querySelector('[data-testid="paged-list-end-failed"]')
        ?.textContent
    ).includes('Could not load more')
  })
})

describe('PagedListEmpty', function () {
  afterEach(unmount)

  const none = <span>Nothing here yet.</span>
  const list = (
    state: Partial<{ loading: boolean; empty: boolean; error: unknown }>,
    refresh: () => Promise<void> = async () => undefined
  ): {
    loading: boolean
    empty: boolean
    error: unknown
    refresh: () => Promise<void>
  } => ({ loading: false, empty: false, error: undefined, refresh, ...state })

  it('shows the spinner while the first page is on its way', async function () {
    await mount(
      <PagedListEmpty
        list={list({ loading: true })}
        loadingLabel="Loading games"
        none={none}
      />
    )
    expect(document.querySelector('[aria-label="Loading games"]')).not.equals(
      null
    )
    expect(document.body.textContent).not.includes('Nothing here yet.')
  })

  it('says what an empty list says, and nothing while rows may still come', async function () {
    await mount(<PagedListEmpty list={list({ empty: true })} none={none} />)
    expect(document.body.textContent).equals('Nothing here yet.')
    await unmount()
    await mount(<PagedListEmpty list={list({})} none={none} />)
    expect(document.body.textContent).equals('')
  })

  it('offers Retry for a first page it could not read, which reads it again', async function () {
    let refreshed = 0
    await mount(
      <PagedListEmpty
        list={list({ error: new Error('Server error') }, async () => {
          refreshed++
        })}
        none={none}
      />
    )
    expect(document.body.textContent).includes('Server error')
    expect(document.body.textContent).not.includes('Nothing here yet.')
    await press('Retry')
    expect(refreshed).equals(1)
  })

  it('leaves the failure to a screen that says it, and retries as it asks', async function () {
    let retried = 0
    await mount(
      <PagedListEmpty
        list={list({ error: 'down' })}
        none={none}
        saysFailure={false}
        onRetry={() => {
          retried++
        }}
      />
    )
    expect(document.querySelector('[role="alert"]')).equals(null)
    await press('Retry')
    expect(retried).equals(1)
    await unmount()
    await mount(
      <PagedListEmpty
        list={list({ error: 'down' })}
        none={none}
        failure="Cannot load games"
      />
    )
    expect(document.body.textContent).includes('Cannot load games')
  })
})
