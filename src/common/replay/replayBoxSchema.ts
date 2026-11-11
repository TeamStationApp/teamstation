import {
  asArray,
  asBoolean,
  asEither,
  asNumber,
  asObject,
  asOptional,
  asString,
  type Cleaner
} from 'cleaners'

import { asLiteral } from '../asLiteral'

const asNullable = <T>(cleaner: Cleaner<T>): Cleaner<T | null> =>
  asEither(asLiteral(null), cleaner)

const asBatting = asObject({
  id: asNumber,
  name: asString,
  ab: asNumber,
  r: asNumber,
  h: asNumber,
  rbi: asNumber,
  bb: asNumber,
  k: asNumber,
  sub: asBoolean,
  current: asBoolean
})
const asPitching = asObject({
  id: asNumber,
  name: asString,
  outs: asNumber,
  ip: asString,
  h: asNumber,
  r: asNumber,
  er: asNumber,
  bb: asNumber,
  k: asNumber,
  hbp: asOptional(asNullable(asNumber), null),
  pc: asNullable(asNumber),
  current: asBoolean
})
const asSide = asObject({
  name: asString,
  batting: asArray(asBatting),
  pitching: asArray(asPitching),
  innings: asArray(asNullable(asNumber)),
  runs: asNumber,
  hits: asNullable(asNumber),
  errors: asNullable(asNumber)
})
export const asReplayBoxScore = asObject({
  away: asSide,
  home: asSide,
  from: asNullable(
    asObject({
      inning: asNumber,
      half: asEither(asLiteral('top'), asLiteral('bottom'))
    })
  )
})
