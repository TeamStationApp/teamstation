import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { SceneShownProvider } from '../components/sceneShown'
import { useNoticedRead } from './useNoticedRead'

let root: Root | undefined

function Reader(props: { refresh: () => Promise<void> }): null {
  useNoticedRead(props.refresh)
  return null
}

/** Renders the reader, shown or covered, and lets its effects run. */
async function show(
  refresh: () => Promise<void>,
  shown: boolean
): Promise<void> {
  if (root == null) {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root!.render(
      <SceneShownProvider value={shown}>
        <Reader refresh={refresh} />
      </SceneShownProvider>
    )
  })
}

describe('a screen’s read on show', () => {
  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = undefined
  })

  it('reads once when first shown, again each time it is shown again, and never while covered', async () => {
    let reads = 0
    const refresh = async (): Promise<void> => {
      reads++
    }
    await show(refresh, true)
    expect(reads, 'the first read').equals(1)
    await show(refresh, true)
    expect(reads, 'a render reads nothing').equals(1)
    await show(refresh, false)
    expect(reads, 'covered').equals(1)
    await show(refresh, true)
    expect(reads, 'shown again').equals(2)
  })

  it('reads once though it was mounted out of sight, so Back reveals it loaded', async () => {
    let reads = 0
    const refresh = async (): Promise<void> => {
      reads++
    }
    await show(refresh, false)
    expect(reads).equals(1)
    await show(refresh, false)
    expect(reads).equals(1)
  })

  it('lets a read that fails go', async () => {
    let reads = 0
    const refresh = async (): Promise<void> => {
      reads++
      throw new Error('no signal')
    }
    await show(refresh, true)
    expect(reads).equals(1)
  })
})
