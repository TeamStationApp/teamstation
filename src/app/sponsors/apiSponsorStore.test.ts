import { expect } from 'chai'
import { describe, it } from 'mocha'

import { HttpError } from '../../common/errors'
import {
  NAME_LIMIT,
  SponsorRuleError
} from '../../common/sponsors/sponsorRules'
import {
  emptySponsorState,
  fakeSponsorClient,
  usedSponsorState
} from '../../test/fakeSponsorClient'
import { createApiSponsorStore, nameOf } from './apiSponsorStore'
import { sponsorStoreFor } from './sponsorStore'
import type {
  PickedFile,
  PlacementDraft,
  PreparedFile,
  SponsorMediaPurpose,
  SponsorState
} from './sponsorTypes'

const NOW = new Date('2026-11-25T20:00:00.000Z')
const LEAGUE = 'lea_al'

const prepared = (name: string, type: string): PreparedFile => ({
  name,
  type,
  size: 4,
  bytes: new Uint8Array(4),
  url: `blob:${name}`,
  width: 480,
  height: 270
})
const picked = (name: string, type = 'image/png'): PickedFile => ({
  name,
  type,
  size: 4,
  url: `blob:${name}`
})

/** A store on the fake server, its pictures "shrunk" by name. */
function setup(state: SponsorState = usedSponsorState(NOW)): {
  client: ReturnType<typeof fakeSponsorClient>
  store: ReturnType<typeof createApiSponsorStore>
  prepared: Array<[SponsorMediaPurpose, string]>
  heard: SponsorState[]
} {
  const client = fakeSponsorClient({ state, now: () => NOW })
  const shrunk: Array<[SponsorMediaPurpose, string]> = []
  const store = createApiSponsorStore(client, LEAGUE, {
    prepare: async (purpose, file) => {
      shrunk.push([purpose, file.name])
      return prepared(file.name, file.type)
    }
  })
  const heard: SponsorState[] = []
  store.subscribe(next => heard.push(next))
  return { client, store, prepared: shrunk, heard }
}

const names = (client: ReturnType<typeof fakeSponsorClient>): string[] =>
  client.calls.map(call => call.name)

const DRAFT: PlacementDraft = {
  logo: picked('logo.png'),
  background: picked('background.jpg', 'image/jpeg'),
  title: 'Bayside Bakery',
  message: 'Fresh bread for every team.',
  url: 'https://example.test/bread',
  textColor: 'white',
  startsAt: '2026-12-01T17:30'
}

describe('U7 the API sponsor store', () => {
  it('reads the league’s state and tells its subscribers', async () => {
    const { client, store, heard } = setup()
    const state = await store.read()
    expect(state.logos.map(logo => logo.name)).deep.equals([
      'Harbor Hardware',
      'Summit Dental',
      'Lakeside Pizza'
    ])
    expect(heard).deep.equals([state])
    expect(client.calls[0]).deep.equals({
      name: 'sponsorState',
      args: [LEAGUE]
    })
  })

  it('uploads a logo and then adds it with its name and allocation', async () => {
    const { client, store, heard } = setup()
    const state = await store.addLogo({
      picked: prepared('Bayside Bakery.png', 'image/png'),
      allocation: 50
    })
    expect(names(client)).deep.equals(['uploadSponsorMedia', 'addSponsorLogo'])
    expect(client.calls[0].args).deep.equals([LEAGUE, 'logo', 'image/png', 4])
    expect(client.calls[1].args).deep.equals([
      LEAGUE,
      { mediaId: 'smd_1', name: 'Bayside Bakery', allocation: 50 }
    ])
    expect(state.logos.at(-1)).deep.include({
      name: 'Bayside Bakery',
      allocation: 50,
      imageUrl: 'https://example.test/media/smd_1'
    })
    expect(heard).deep.equals([state])
  })

  it('uploads a reel and then adds it', async () => {
    const { client, store } = setup()
    await store.addReel({
      picked: prepared('Ridgeview Spring.mp4', 'video/mp4'),
      durationSec: 12,
      allocation: 100
    })
    expect(names(client)).deep.equals(['uploadSponsorMedia', 'addSponsorReel'])
    expect(client.calls[0].args).deep.equals([LEAGUE, 'reel', 'video/mp4', 4])
    expect(client.calls[1].args[1]).deep.equals({
      mediaId: 'smd_1',
      name: 'Ridgeview Spring',
      allocation: 100
    })
  })

  it('changes and deactivates logos and reels through their routes', async () => {
    const { client, store, heard } = setup()
    await store.setLogoAllocation('slg_summit', 60)
    await store.deactivateLogo('slg_summit')
    await store.setReelAllocation('srl_ridgeview', 150)
    const last = await store.deactivateReel('srl_harbor')
    expect(client.calls).deep.equals([
      { name: 'setSponsorLogoAllocation', args: ['slg_summit', 60] },
      { name: 'deactivateSponsorLogo', args: ['slg_summit'] },
      { name: 'setSponsorReelAllocation', args: ['srl_ridgeview', 150] },
      { name: 'deactivateSponsorReel', args: ['srl_harbor'] }
    ])
    expect(heard).has.length(4)
    expect(last.logos.map(logo => logo.id)).not.includes('slg_summit')
    expect(last.reels.find(reel => reel.id === 'srl_harbor')?.active).equals(
      false
    )
  })

  it('rejects a server refusal as the rule’s sentence and leaves the state', async () => {
    const { client, store, heard } = setup()
    const before = client.state()
    let caught: unknown
    try {
      await store.setLogoAllocation('slg_summit', 999)
    } catch (error) {
      caught = error
    }
    expect(caught).instanceOf(SponsorRuleError)
    expect((caught as Error).message).equals(
      'Only 170 game logo credits are left to assign.'
    )
    expect(client.state()).equals(before)
    expect(heard).deep.equals([])
  })

  it('passes on a failure that is not a refusal as it is', async () => {
    const { client, store } = setup()
    const offline = new HttpError('internal', 'The server failed')
    client.failNext('deleteSponsorRow', offline)
    let caught: unknown
    try {
      await store.deletePlacement('ser_lakeside')
    } catch (error) {
      caught = error
    }
    expect(caught).equals(offline)
  })

  it('places a row: shrinks and uploads its logo and background, then adds it with both', async () => {
    const { client, store, prepared: shrunk } = setup()
    const state = await store.addPlacement(DRAFT)
    expect(shrunk).deep.equals([
      ['rowLogo', 'logo.png'],
      ['rowBackground', 'background.jpg']
    ])
    expect(names(client)).deep.equals([
      'uploadSponsorMedia',
      'uploadSponsorMedia',
      'addSponsorRow'
    ])
    expect(client.calls[0].args.slice(1, 3)).deep.equals([
      'rowLogo',
      'image/png'
    ])
    expect(client.calls[1].args.slice(1, 3)).deep.equals([
      'rowBackground',
      'image/jpeg'
    ])
    expect(client.calls[2].args[1]).deep.equals({
      logoMediaId: 'smd_1',
      backgroundMediaId: 'smd_2',
      title: 'Bayside Bakery',
      message: 'Fresh bread for every team.',
      url: 'https://example.test/bread',
      textColor: 'white',
      startsAt: new Date('2026-12-01T17:30').toISOString()
    })
    expect(state.placements).has.length(3)
  })

  it('refuses a row without a background before uploading anything', async () => {
    const { client, store } = setup()
    let caught: unknown
    try {
      await store.addPlacement({ ...DRAFT, background: null })
    } catch (error) {
      caught = error
    }
    expect(caught).instanceOf(SponsorRuleError)
    expect(client.calls).deep.equals([])
  })

  it('edits a row with only its new background, sending no logo media id', async () => {
    const { client, store, prepared: shrunk } = setup()
    const state = await store.editPlacement('ser_lakeside', {
      ...DRAFT,
      logo: null,
      title: 'Lakeside Pizza'
    })
    expect(shrunk).deep.equals([['rowBackground', 'background.jpg']])
    expect(names(client)).deep.equals(['uploadSponsorMedia', 'editSponsorRow'])
    const [id, patch] = client.calls[1].args as [
      string,
      Record<string, unknown>
    ]
    expect(id).equals('ser_lakeside')
    expect(patch).not.has.property('logoMediaId')
    expect(patch.backgroundMediaId).equals('smd_1')
    const row = state.placements.find(each => each.id === 'ser_lakeside')
    expect(row?.logoUrl).equals(
      usedSponsorState(NOW).placements[1].logoUrl,
      'the logo is kept'
    )
    expect(row?.backgroundUrl).equals('https://example.test/media/smd_1')
  })

  it('edits a row with a new logo and keeps its background', async () => {
    const { client, store } = setup()
    await store.editPlacement('ser_lakeside', { ...DRAFT, background: null })
    const patch = client.calls[1].args[1] as Record<string, unknown>
    expect(patch.logoMediaId).equals('smd_1')
    expect(patch).not.has.property('backgroundMediaId')
  })

  it('makes no add or edit call when an upload fails', async () => {
    for (const run of [
      async (store: ReturnType<typeof createApiSponsorStore>) => {
        await store.addLogo({
          picked: prepared('a.png', 'image/png'),
          allocation: 5
        })
      },
      async (store: ReturnType<typeof createApiSponsorStore>) => {
        await store.addReel({
          picked: prepared('a.mp4', 'video/mp4'),
          durationSec: 12,
          allocation: 5
        })
      },
      async (store: ReturnType<typeof createApiSponsorStore>) => {
        await store.addPlacement(DRAFT)
      },
      async (store: ReturnType<typeof createApiSponsorStore>) => {
        await store.editPlacement('ser_lakeside', { ...DRAFT, logo: null })
      }
    ]) {
      const { client, store } = setup()
      client.failNext(
        'uploadSponsorMedia',
        new HttpError('badRequest', 'Images must be JPEG or PNG.')
      )
      let caught: unknown
      try {
        await run(store)
      } catch (error) {
        caught = error
      }
      expect((caught as Error).message).equals('Images must be JPEG or PNG.')
      expect(names(client)).deep.equals(['uploadSponsorMedia'])
    }
  })

  it('refuses an edit after 24 hours and deletes with or without the slot', async () => {
    const { store } = setup()
    let caught: unknown
    try {
      await store.editPlacement('ser_summit', {
        ...DRAFT,
        logo: null,
        background: null
      })
    } catch (error) {
      caught = error
    }
    expect((caught as Error).message).equals(
      'This placement is more than 24 hours old; it can only be deleted.'
    )
    const kept = await store.deletePlacement('ser_summit')
    expect(kept.keptSlots).equals(1)
    const returned = await store.deletePlacement('ser_lakeside')
    expect(returned.keptSlots).equals(1)
    expect(returned.placements).deep.equals([])
  })

  it('refuses a draft whose date cannot be read', async () => {
    const { client, store } = setup(emptySponsorState())
    let caught: unknown
    try {
      await store.addPlacement({ ...DRAFT, startsAt: '' })
    } catch (error) {
      caught = error
    }
    expect(caught).instanceOf(SponsorRuleError)
    expect(client.calls).deep.equals([])
  })

  it('stops telling a subscriber that unsubscribed', async () => {
    const client = fakeSponsorClient({ now: () => NOW })
    const store = createApiSponsorStore(client, LEAGUE)
    const heard: SponsorState[] = []
    const stop = store.subscribe(next => heard.push(next))
    await store.read()
    stop()
    await store.read()
    expect(heard).has.length(1)
  })

  it('keeps one store per league and client', () => {
    const client = fakeSponsorClient()
    const other = fakeSponsorClient()
    const store = sponsorStoreFor(LEAGUE, client)
    expect(sponsorStoreFor(LEAGUE, client)).equals(store)
    expect(sponsorStoreFor('lea_nl', client)).not.equals(store)
    expect(sponsorStoreFor(LEAGUE, other)).not.equals(store)
  })

  it('names a row after its file without the extension', () => {
    expect(nameOf({ name: 'Bayside Bakery.png' })).equals('Bayside Bakery')
    expect(nameOf({ name: '.png' })).equals('.png')
  })

  it('cuts a long file name to the 80 code points the server takes, never inside a code point', () => {
    const long = `${'Bayside Bakery '.repeat(10)}.png`
    const name = nameOf({ name: long })
    expect(Array.from(name).length).at.most(NAME_LIMIT)
    expect(long.startsWith(name)).equals(true)
    expect(name).equals(name.trim())
    const emoji = `${'🥖'.repeat(NAME_LIMIT + 5)}.jpg`
    expect(nameOf({ name: emoji })).equals('🥖'.repeat(NAME_LIMIT))
    expect(nameOf({ name: `${'a'.repeat(NAME_LIMIT)}.png` })).equals(
      'a'.repeat(NAME_LIMIT)
    )
  })
})
