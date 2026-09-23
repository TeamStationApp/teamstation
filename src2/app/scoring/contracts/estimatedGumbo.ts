import {
  asArray,
  asBoolean,
  asEither,
  asNumber,
  asObject,
  asOptional,
  asString,
  asValue
} from 'cleaners'

export function asSessionId(raw: unknown): number {
  const id = asNumber(raw)
  if (!Number.isSafeInteger(id) || id < 0)
    throw new Error('Invalid local player id')
  return id
}
export const asPlayerRef = asObject({ id: asSessionId, fullName: asString })
const asCount = asObject({ balls: asNumber, strikes: asNumber, outs: asNumber })
const asCredit = asObject({
  player: asPlayerRef,
  credit: asEither(asValue('f_assist' as const), asValue('f_putout' as const)),
  position: asString
})
export const asEstimatedGumboPlay = asObject({
  about: asObject({
    atBatIndex: asSessionId,
    inning: asNumber,
    halfInning: asEither(asValue('top' as const), asValue('bottom' as const)),
    isComplete: asBoolean
  }),
  result: asObject({
    event: asString,
    eventType: asString,
    description: asString,
    awayScore: asNumber,
    homeScore: asNumber,
    rbi: asNumber
  }),
  count: asCount,
  matchup: asObject({
    batter: asPlayerRef,
    pitcher: asPlayerRef,
    batSide: asObject({
      code: asEither(asValue('R' as const), asValue('L' as const))
    })
  }),
  runners: asArray(
    asObject({
      movement: asObject({
        originBase: asNumber,
        start: asNumber,
        end: asNumber,
        isOut: asBoolean,
        outNumber: asOptional(asNumber),
        forceOut: asBoolean,
        runScored: asOptional(asBoolean)
      }),
      details: asObject({ runner: asPlayerRef, movementReason: asString }),
      credits: asArray(asCredit)
    })
  ),
  playEvents: asArray(
    asObject({
      index: asSessionId,
      isPitch: asBoolean,
      type: asString,
      details: asObject({ description: asString, code: asString }),
      count: asCount,
      player: asPlayerRef
    })
  ),
  hitData: asOptional(
    asObject({
      launchAngle: asNumber,
      trajectory: asString,
      coordinates: asObject({ x: asNumber, z: asNumber }),
      fielder: asPlayerRef
    })
  ),
  source: asObject({
    system: asValue('gamestation' as const),
    gamestation: asObject({
      version: asValue('estimated-v1' as const),
      outcome: asString,
      outSubtype: asOptional(asString),
      runnerActions: asOptional(
        asArray(
          asObject({
            runner: asPlayerRef,
            origin: asNumber,
            destination: asNumber,
            reason: asString,
            isOut: asBoolean,
            forceOut: asBoolean,
            runScored: asBoolean,
            credits: asArray(asCredit),
            throwerLocation: asOptional(asObject({ x: asNumber, z: asNumber })),
            defenderLocation: asOptional(asObject({ x: asNumber, z: asNumber }))
          })
        )
      )
    })
  })
})
/** Local development estimate; never use this payload as a persisted identity contract. */
export type EstimatedGumboPlay = ReturnType<typeof asEstimatedGumboPlay>
