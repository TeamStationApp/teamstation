import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import type { OutboxSummary } from './outbox'
import { useUnsentEditsWarning } from './useOffline'

const queue = (count: number): OutboxSummary => ({
  count,
  chains: {},
  games: {},
  teams: {}
})

function Probe({ summary }: { summary: OutboxSummary | undefined }): null {
  useUnsentEditsWarning(summary)
  return null
}

describe('the warning before a page with unsent edits unloads', function () {
  let root: Root | undefined
  let host: HTMLElement | undefined

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    host?.remove()
  })

  async function show(summary: OutboxSummary | undefined): Promise<void> {
    await act(async () => {
      root!.render(React.createElement(Probe, { summary }))
    })
  }

  /** Whether an unload now would be asked about. */
  function warns(): boolean {
    const event = new window.Event('beforeunload', { cancelable: true })
    window.dispatchEvent(event)
    return event.defaultPrevented
  }

  it('warns while the queue holds an edit, and not once it is empty', async function () {
    await show(undefined)
    expect(warns(), 'no queue read yet').equals(false)
    await show(queue(0))
    expect(warns(), 'an empty queue').equals(false)
    await show(queue(2))
    expect(warns(), 'two edits waiting').equals(true)
    await show(queue(1))
    expect(warns(), 'one edit still waiting').equals(true)
    await show(queue(0))
    expect(warns(), 'the queue sent').equals(false)
    await show(queue(1))
    await act(async () => {
      root!.unmount()
    })
    root = undefined
    expect(warns(), 'unmounted').equals(false)
  })

  it('adds nothing where the window has no events, as on the phone', async function () {
    // React Native's `window` is the global object, with no events.
    const events = window as { addEventListener?: unknown }
    const add = events.addEventListener
    events.addEventListener = undefined
    try {
      await show(queue(1))
    } finally {
      events.addEventListener = add
    }
    expect(warns()).equals(false)
  })
})
