import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { ThemeProvider } from '../theme/ThemeContext'
import { SlowMoBadge } from './GestureFeedback'

let root: Root | undefined
let host: HTMLElement | undefined

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
  host?.remove()
  host = undefined
})

async function badge(props: {
  rate: number
  top?: number
  right?: number
}): Promise<HTMLElement | null> {
  if (root == null) {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  }
  await act(async () => {
    root?.render(
      <ThemeProvider>
        <SlowMoBadge {...props} />
      </ThemeProvider>
    )
  })
  const words = Array.from(host?.querySelectorAll('div') ?? []).find(
    node =>
      node.children.length === 0 && (node.textContent ?? '').includes('Slow Mo')
  )
  return words?.parentElement ?? null
}

describe('the Slow Mo pill', function () {
  it('is drawn only during a crawl', async function () {
    expect(await badge({ rate: 0 })).equals(null)
    expect(await badge({ rate: 0.25 })).not.equals(null)
  })

  it('steps in from the right, and down from the top, when told to', async function () {
    const pill = await badge({ rate: 0.25, top: 30, right: 64 })
    expect(pill?.style.right).equals('64px')
    expect(pill?.style.top).equals('30px')
  })
})
