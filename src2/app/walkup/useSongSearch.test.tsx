import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

import { type SongSearch, useSongSearch } from './useSongSearch'
import type { SongCandidate, WalkUpMusic } from './walkUpMusicTypes'

let root: Root | undefined
let search: SongSearch | undefined
const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function song(title: string): SongCandidate {
  return {
    provider: 'localFile',
    providerId: 'lf:0000000000000000',
    isrc: null,
    title,
    artist: 'A',
    album: null,
    artworkUrl: null,
    durationMs: 90000,
    source: 'device',
    handle: `content://${title}`
  }
}

function music(
  answer: (term: string) => Promise<SongCandidate[]>
): WalkUpMusic & { terms: string[] } {
  const terms: string[] = []
  return {
    available: true,
    providerName: 'This phone',
    access: async () => 'authorized',
    search: async term => {
      terms.push(term)
      return await answer(term)
    },
    pickFile: async () => null,
    play: async () => undefined,
    stop: async () => undefined,
    onState: () => () => undefined,
    terms
  }
}

function Harness(props: {
  music: WalkUpMusic
  enabled?: boolean
}): React.ReactElement {
  search = useSongSearch(props.music, props.enabled)
  return <div />
}

async function mount(element: React.ReactElement): Promise<void> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(element)
  })
}

async function type(term: string, wait = 0): Promise<void> {
  await act(async () => {
    search!.setTerm(term)
  })
  await act(async () => {
    await delay(wait)
  })
}

afterEach(async function () {
  await act(async () => {
    root?.unmount()
  })
  root = undefined
})

describe('useSongSearch', function () {
  it('waits for typing to pause, and needs two characters', async function () {
    const phone = music(async term => [song(term)])
    await mount(<Harness music={phone} />)
    await type('w', 400)
    expect(phone.terms).deep.equals([])
    expect(search!.status).equals('idle')
    await type('wa', 100)
    await type('wal', 100)
    await type('walkup fixture ', 100)
    expect(phone.terms).deep.equals([])
    await act(async () => {
      await delay(300)
    })
    expect(phone.terms).deep.equals(['walkup fixture'])
    expect(search!.status).equals('done')
    expect(search!.results.map(found => found.title)).deep.equals([
      'walkup fixture'
    ])
    await type('', 10)
    expect(search!.status).equals('idle')
    expect(search!.results).deep.equals([])
  })

  it('shows only the answer to the latest term', async function () {
    const slow = new Map<string, (found: SongCandidate[]) => void>()
    const phone = music(
      async term =>
        await new Promise<SongCandidate[]>(resolve => {
          slow.set(term, resolve)
        })
    )
    await mount(<Harness music={phone} />)
    await type('first', 350)
    expect(search!.status).equals('searching')
    await type('second', 350)
    await act(async () => {
      slow.get('second')!([song('second')])
      await delay(5)
    })
    await act(async () => {
      slow.get('first')!([song('first')])
      await delay(5)
    })
    expect(search!.results.map(found => found.title)).deep.equals(['second'])
  })

  it('keeps the error, drops a stale one, and retries at once', async function () {
    let fail = true
    const phone = music(async term => {
      if (fail) throw new Error('Failed to request developer token')
      return [song(term)]
    })
    await mount(<Harness music={phone} />)
    await type('centerfield', 350)
    expect(search!.status).equals('error')
    expect(search!.error).equals('Failed to request developer token')
    fail = false
    await act(async () => {
      search!.retry()
    })
    await act(async () => {
      await delay(20)
    })
    expect(search!.status).equals('done')
    expect(phone.terms).deep.equals(['centerfield', 'centerfield'])

    const raw = music(async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'offline'
    })
    await act(async () => {
      root?.unmount()
    })
    await mount(<Harness music={raw} />)
    await type('centerfield', 350)
    expect(search!.error).equals('offline')
  })

  it('does not search until access is granted', async function () {
    const phone = music(async () => [])
    await mount(<Harness music={phone} enabled={false} />)
    await type('centerfield', 350)
    expect(phone.terms).deep.equals([])
    expect(search!.status).equals('idle')
  })
})
