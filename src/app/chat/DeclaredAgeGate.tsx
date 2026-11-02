import React, { createContext, useContext, useEffect, useState } from 'react'
import { NativeModules, Platform } from 'react-native'

import {
  type ChatGate,
  chatGate,
  type DeclaredAgeAnswer,
  webDeclaredAge
} from './declaredAge'

declare const TS_DECLARED_AGE_LOWER: string | undefined

const UNREADY_TRIES = 10
const UNREADY_WAIT_MS = 200

const GateContext = createContext<ChatGate>('allowed')
const OverrideContext = createContext<ChatGate | undefined>(undefined)

function standIn(): string {
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

/** Apple's answer, the dev-server stand-in, or `unsupported` where the API is absent. */
export async function requestDeclaredAge(): Promise<DeclaredAgeAnswer> {
  if (Platform.OS !== 'ios') return webDeclaredAge(standIn())
  const raw = standIn()
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
    await new Promise(resolve => setTimeout(resolve, UNREADY_WAIT_MS))
  }
  return { status: 'unavailable' }
}

/** The settled gate. The first value is `allowed`, before the request starts. */
export function useDeclaredAgeGate(): ChatGate {
  return useContext(GateContext)
}

/** Chat stays up until the gate is `denied`. */
export function useChatAllowed(): boolean {
  return useDeclaredAgeGate() !== 'denied'
}

/** A test, or a parent, that already knows the gate. */
export function ChatGateOverride(props: {
  gate: ChatGate
  children: React.ReactNode
}): React.ReactElement {
  return (
    <OverrideContext.Provider value={props.gate}>
      <GateContext.Provider value={props.gate}>
        {props.children}
      </GateContext.Provider>
    </OverrideContext.Provider>
  )
}

/**
 * Asks once. Web and Android never call the native module. On iOS the first
 * render stays `allowed`, and `pending` is the in-flight value.
 */
export function DeclaredAgeGateProvider(props: {
  children: React.ReactNode
}): React.ReactElement {
  const override = useContext(OverrideContext)
  const [gate, setGate] = useState<ChatGate>('allowed')
  useEffect(() => {
    if (override != null) return
    let live = true
    if (Platform.OS === 'ios') setGate('pending')
    requestDeclaredAge()
      .then(answer => {
        if (live) setGate(chatGate(answer))
      })
      .catch(() => {
        if (live) setGate('allowed')
      })
    return () => {
      live = false
    }
  }, [override])
  return (
    <GateContext.Provider value={override ?? gate}>
      {props.children}
    </GateContext.Provider>
  )
}
