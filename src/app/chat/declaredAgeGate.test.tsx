import { expect } from 'chai'
import { afterEach, describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NativeModules, Platform } from 'react-native'

import type { AppleAge, DeclaredAgeAnswer } from './declaredAge'
import {
  AppleAgeOverride,
  DeclaredAgeGateProvider,
  requestDeclaredAge,
  useAppleAge
} from './DeclaredAgeGate'

let root: Root | undefined
const delay = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
  delete NativeModules.TSDeclaredAge
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' })
})

async function mount(element: React.ReactElement): Promise<void> {
  if (root != null) {
    await act(async () => root?.unmount())
    document.body.replaceChildren()
  }
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(element)
  })
}

describe('the declared age answer', () => {
  function Probe(props: { seen: AppleAge[] }): null {
    props.seen.push(useAppleAge())
    return null
  }

  it('settles on none on the web and Android without a stand-in, never calling the native module', async () => {
    let calls = 0
    NativeModules.TSDeclaredAge = {
      request: async () => {
        calls += 1
        return { status: 'declined' }
      }
    }
    for (const os of ['web', 'android']) {
      Object.defineProperty(Platform, 'OS', { configurable: true, value: os })
      const seen: AppleAge[] = []
      await mount(
        <DeclaredAgeGateProvider standIn="">
          <Probe seen={seen} />
        </DeclaredAgeGateProvider>
      )
      await act(async () => {
        await delay(30)
      })
      expect(seen[0], os).equals('none')
      expect(seen.at(-1), os).equals('none')
    }
    expect(calls).equals(0)
  })

  it('reads a numeric stand-in on the web as a shared range', async () => {
    for (const [standIn, age] of [
      ['13', 'over13'],
      ['18', 'over13'],
      ['12', 'under13'],
      ['nope', 'none']
    ] as const) {
      const seen: AppleAge[] = []
      await mount(
        <DeclaredAgeGateProvider standIn={standIn}>
          <Probe seen={seen} />
        </DeclaredAgeGateProvider>
      )
      await act(async () => {
        await delay(20)
      })
      expect(seen.at(-1), standIn).equals(age)
    }
    expect(await requestDeclaredAge('13')).deep.equals({
      status: 'sharing',
      lowerBound: 13
    })
  })

  it('treats a thrown native request and an unknown status as unavailable', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
    NativeModules.TSDeclaredAge = {
      request: async () => {
        throw new Error('sheet failed')
      }
    }
    expect(await requestDeclaredAge('')).deep.equals({ status: 'unavailable' })
    NativeModules.TSDeclaredAge = {
      request: async () => ({ status: 'nope' })
    }
    expect(await requestDeclaredAge('')).deep.equals({ status: 'unavailable' })
    NativeModules.TSDeclaredAge = {
      request: async () => ({
        status: 'sharing',
        lowerBound: 15,
        upperBound: 17
      })
    }
    expect(await requestDeclaredAge('')).deep.equals({
      status: 'sharing',
      lowerBound: 15,
      upperBound: 17
    })
    expect(await requestDeclaredAge('12')).deep.equals({
      status: 'sharing',
      lowerBound: 12
    })
  })

  it('is pending while an iOS request is in flight, then the answer it gave', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
    for (const [answer, age] of [
      [{ status: 'declined' }, 'declined'],
      [{ status: 'sharing', lowerBound: 12 }, 'under13'],
      [{ status: 'sharing', lowerBound: 13 }, 'over13'],
      [{ status: 'unsupported' }, 'none'],
      [{ status: 'unavailable' }, 'none']
    ] as Array<[DeclaredAgeAnswer, AppleAge]>) {
      let release: (() => void) | undefined
      NativeModules.TSDeclaredAge = {
        request: async () =>
          await new Promise(resolve => {
            release = () => {
              resolve(answer)
            }
          })
      }
      const seen: AppleAge[] = []
      await mount(
        <DeclaredAgeGateProvider standIn="">
          <Probe seen={seen} />
        </DeclaredAgeGateProvider>
      )
      await act(async () => {
        await delay(10)
      })
      expect(seen[0]).equals('pending')
      expect(seen.at(-1)).equals('pending')
      await act(async () => {
        release?.()
        await delay(10)
      })
      expect(seen.at(-1), JSON.stringify(answer)).equals(age)
    }
  })

  it('keeps a known answer from a parent, and asks nothing', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
    let calls = 0
    NativeModules.TSDeclaredAge = {
      request: async () => {
        calls += 1
        return { status: 'declined' }
      }
    }
    const seen: AppleAge[] = []
    await mount(
      <AppleAgeOverride age="under13">
        <DeclaredAgeGateProvider>
          <Probe seen={seen} />
        </DeclaredAgeGateProvider>
      </AppleAgeOverride>
    )
    await act(async () => {
      await delay(20)
    })
    expect(seen.at(-1)).equals('under13')
    expect(calls).equals(0)
  })

  it('retries an unready answer ten times and then treats it as unavailable', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
    let calls = 0
    NativeModules.TSDeclaredAge = {
      request: async () => {
        calls += 1
        return { status: 'unready' }
      }
    }
    const answer = await requestDeclaredAge('')
    expect(answer).deep.equals({ status: 'unavailable' })
    expect(calls).equals(11)
  }).timeout(10000)

  it('treats a missing native module as unsupported', async () => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: 'ios' })
    delete NativeModules.TSDeclaredAge
    expect(await requestDeclaredAge('')).deep.equals({ status: 'unsupported' })
  })
})
