// The cleaners for sponsor answers, as the client reads them.
import {
  asArray,
  asBoolean,
  asEither,
  asNull,
  asNumber,
  asObject,
  asOptional,
  asString,
  asValue,
  type Cleaner
} from 'cleaners'

import { asSponsorOverlay } from '../nodeSettings'
import type { SampleVideo, SponsorState, UploadedSponsorMedia } from './types'

const asTextColor = asValue('dark', 'white')

const asCredit = {
  id: asString,
  name: asString,
  allocation: asNumber,
  used: asNumber,
  active: asBoolean
}

export const asSponsorState: Cleaner<SponsorState> = asObject({
  totals: asObject({
    logoCredits: asNumber,
    reelCredits: asNumber,
    eventSlots: asNumber
  }),
  logos: asArray(asObject({ ...asCredit, imageUrl: asString })),
  reels: asArray(
    asObject({
      ...asCredit,
      videoUrl: asString,
      posterUrl: asString,
      durationSec: asNumber
    })
  ),
  placements: asArray(
    asObject({
      id: asString,
      logoUrl: asString,
      backgroundUrl: asString,
      title: asString,
      message: asString,
      url: asString,
      textColor: asOptional(asTextColor),
      startsAt: asString,
      placedAt: asString
    })
  ),
  keptSlots: asNumber
})

export const asUploadedSponsorMedia: Cleaner<UploadedSponsorMedia> = asObject({
  mediaId: asString,
  url: asString,
  width: asNumber,
  height: asNumber,
  durationMs: asEither(asNumber, asNull)
})

const asWindow: Cleaner<[number, number]> = raw => {
  const [start, end] = asArray(asNumber)(raw)
  if (start == null || end == null || !(end > start))
    throw new TypeError('Expected a window of two times')
  return [start, end]
}

export const asSampleVideo: Cleaner<SampleVideo> = raw => {
  const common = asObject({
    kind: asValue('recording', 'node'),
    url: asString,
    window: asWindow,
    overlay: asSponsorOverlay
  })(raw)
  if (common.kind === 'node') return { ...common, kind: 'node' }
  const { videoId } = asObject({ videoId: asString })(raw)
  return { ...common, kind: 'recording', videoId }
}
