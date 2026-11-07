import { asArray, asNumber, asObject, asString } from 'cleaners'

import { asLiteral } from './asLiteral'

export interface RecapSentence {
  text: string
  kind: 'play' | 'summary' | 'totals'
  plays: number[]
}
export interface RecapDocument {
  headline: string
  dateLine: string
  paragraphs: RecapSentence[][]
}
export interface RecapClip {
  videoId: string
  start: number
  end: number
}
export interface GameRecap {
  status: 'absent' | 'pending' | 'failed' | 'ready'
  document: RecapDocument | null
  clips: Record<string, RecapClip>
}

const text = (raw: unknown): string => {
  const value = asString(raw).trim()
  if (value.length === 0 || value.length > 2000)
    throw new Error('Invalid recap text')
  return value
}
const sentence = asObject({
  text,
  kind: asLiteral('play', 'summary', 'totals'),
  plays: asArray(asNumber)
})
const document = asObject({
  headline: text,
  dateLine: text,
  paragraphs: asArray(asArray(sentence))
})

/** Treat model output as data: bounded plain text and known play references. */
export function asRecapDocument(raw: unknown): RecapDocument {
  const value = document(raw)
  const sentences = value.paragraphs.flat()
  if (
    value.paragraphs.length === 0 ||
    value.paragraphs.length > 30 ||
    value.paragraphs.some(p => p.length === 0) ||
    sentences.length > 100 ||
    JSON.stringify(value).length > 40000 ||
    sentences.some(
      s =>
        s.plays.length > 100 ||
        s.plays.some(p => !Number.isInteger(p) || p < 0) ||
        new Set(s.plays).size !== s.plays.length
    )
  )
    throw new Error('Invalid recap document')
  return value
}

export function validateRecap(
  raw: unknown,
  indexes: ReadonlySet<number>
): RecapDocument {
  const value = asRecapDocument(raw)
  if (value.paragraphs.flat().some(s => s.plays.some(p => !indexes.has(p))))
    throw new Error('Recap references an unknown play')
  return value
}

/** Only a sentence about exactly one play is a video link. */
export function recapPlay(sentence: RecapSentence): number | null {
  return sentence.kind === 'play' && sentence.plays.length === 1
    ? sentence.plays[0]
    : null
}

export function asGameRecap(raw: unknown): GameRecap {
  const value = asObject({
    status: asLiteral('absent', 'pending', 'failed', 'ready'),
    document: (v: unknown) => (v === null ? null : asRecapDocument(v)),
    clips: (v: unknown): Record<string, RecapClip> => {
      if (v === null || typeof v !== 'object' || Array.isArray(v))
        throw new Error('Invalid recap clips')
      const out: Record<string, RecapClip> = {}
      for (const [key, raw] of Object.entries(v)) {
        const clip = asObject({
          videoId: text,
          start: asNumber,
          end: asNumber
        })(raw)
        if (
          !/^\d+$/.test(key) ||
          !Number.isFinite(clip.start) ||
          !Number.isFinite(clip.end) ||
          clip.start < 0 ||
          clip.end <= clip.start
        )
          throw new Error('Invalid recap clip')
        out[key] = clip
      }
      return out
    }
  })(raw)
  if ((value.status === 'ready') !== (value.document !== null))
    throw new Error('Invalid recap state')
  return value
}
