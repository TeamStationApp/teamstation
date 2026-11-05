import React, { createContext, useContext, useEffect, useState } from 'react'
import { NativeModules, Platform } from 'react-native'

import {
  type AppleAge,
  appleAgeOf,
  type DeclaredAgeAnswer,
  webDeclaredAge
} from './declaredAge'

declare const TS_DECLARED_AGE_LOWER: string | undefined

const UNREADY_TRIES = 10
const UNREADY_WAIT_MS = 200

const AgeContext = createContext<AppleAge>('none')
const OverrideContext = createContext<AppleAge | undefined>(undefined)

/** The build's stand-in for Apple's answer: `''` but on a dev serve. */
function standInOf(): string {
  return typeof TS_DECLARED_AGE_LOWER === 'string' ? TS_DECLARED_AGE_LOWER : ''
}

function normalize(raw: unknown): DeclaredAgeAnswer {
  if (raw == null || typeof raw !== 'object') return { status: 'unavailable' }
  const body = raw as {
    status?: unknown
    lowerBound?: unknown
    upperBound?: unknown
  }
  if (body.status === 'sharing') {
    const answer: DeclaredAgeAnswer = { status: 'sharing' }
    if (typeof body.lowerBound === 'number') answer.lowerBound = body.lowerBound
    if (typeof body.upperBound === 'number') answer.upperBound = body.upperBound
    return answer
  }
  if (
    body.status === 'unsupported' ||
    body.status === 'unready' ||
    body.status === 'unavailable' ||
    body.status === 'declined'
  ) {
    return { status: body.status }
  }
  return { status: 'unavailable' }
}

/**
 * Apple's answer, the dev-server stand-in, or `unsupported` where the API is
 * absent. A test hands the stand-in in, whatever its bundle defines.
 */
export async function requestDeclaredAge(
  raw: string = standInOf()
): Promise<DeclaredAgeAnswer> {
  if (Platform.OS !== 'ios') return webDeclaredAge(raw)
  if (/^-?\d+$/.test(raw)) return webDeclaredAge(raw)
  const native = NativeModules.TSDeclaredAge as
    { request?: () => Promise<unknown> } | undefined
  if (native?.request == null) return { status: 'unsupported' }
  for (let attempt = 0; attempt <= UNREADY_TRIES; attempt++) {
    let answer: DeclaredAgeAnswer
    try {
      answer = normalize(await native.request())
    } catch {
      return { status: 'unavailable' }
    }
    if (answer.status !== 'unready') return answer
    if (attempt === UNREADY_TRIES) return { status: 'unavailable' }
    await new Promise<void>(resolve => setTimeout(resolve, UNREADY_WAIT_MS))
  }
  return { status: 'unavailable' }
}

/**
 * This device's age answer: `none` at once on the web and Android without a
 * stand-in, and on iOS `pending` until Apple answers.
 */
export function useAppleAge(): AppleAge {
  return useContext(AgeContext)
}

/** A test, or a parent, that already knows the answer. */
export function AppleAgeOverride(props: {
  age: AppleAge
  children: React.ReactNode
}): React.ReactElement {
  return (
    <OverrideContext.Provider value={props.age}>
      <AgeContext.Provider value={props.age}>
        {props.children}
      </AgeContext.Provider>
    </OverrideContext.Provider>
  )
}

/**
 * Asks once. Web and Android never call the native module: they read the
 * build's stand-in, `none` without one. On iOS the first value is `pending`.
 */
export function DeclaredAgeGateProvider(props: {
  children: React.ReactNode
  /** The stand-in, for a test; the build's own when absent. */
  standIn?: string
}): React.ReactElement {
  const override = useContext(OverrideContext)
  const { standIn } = props
  const [age, setAge] = useState<AppleAge>(() =>
    Platform.OS === 'ios' ? 'pending' : 'none'
  )
  useEffect(() => {
    if (override != null) return
    let live = true
    requestDeclaredAge(standIn)
      .then(answer => {
        if (live) setAge(appleAgeOf(answer))
      })
      .catch(() => {
        if (live) setAge('none')
      })
    return () => {
      live = false
    }
  }, [override, standIn])
  return (
    <AgeContext.Provider value={override ?? age}>
      {props.children}
    </AgeContext.Provider>
  )
}
