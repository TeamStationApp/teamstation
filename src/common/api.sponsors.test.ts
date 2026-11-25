import { expect } from 'chai'
import { describe, it } from 'mocha'

import { TeamStationClient } from './api'
import { defaultSponsorSettings } from './nodeSettings'
import type { SponsorState } from './sponsors/types'

interface Call {
  url: string
  method: string
  type: string | null
  body: unknown
}

function client(answer: unknown): { api: TeamStationClient; calls: Call[] } {
  const calls: Call[] = []
  const api = new TeamStationClient({
    baseUrl: '/api/v1',
    fetch: (async (
      url: unknown,
      init?: {
        method?: string
        body?: string | Uint8Array
        headers?: Record<string, string>
      }
    ) => {
      const body = init?.body
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        type: init?.headers?.['content-type'] ?? null,
        body:
          body == null
            ? undefined
            : typeof body === 'string'
              ? JSON.parse(body)
              : [...body]
      })
      return new Response(JSON.stringify(answer), { status: 200 })
    }) as unknown as typeof fetch
  })
  return { api, calls }
}

const state: SponsorState = {
  totals: { logoCredits: 300, reelCredits: 1000, eventSlots: 10 },
  logos: [
    {
      id: 'slg_a',
      name: 'Harbor',
      imageUrl: 'https://media.example.test/a.png',
      allocation: 50,
      used: 0,
      active: true
    }
  ],
  reels: [
    {
      id: 'srl_a',
      name: 'Harbor',
      videoUrl: 'https://media.example.test/a.mp4',
      posterUrl: '',
      durationSec: 12,
      allocation: 100,
      used: 0,
      active: true
    }
  ],
  placements: [
    {
      id: 'ser_a',
      logoUrl: 'https://media.example.test/l.png',
      backgroundUrl: 'https://media.example.test/b.jpg',
      title: 'Harbor',
      message: 'Ten percent off.',
      url: 'https://harbor.example.test',
      textColor: 'white',
      startsAt: '2027-04-01T18:00:00.000Z',
      placedAt: '2027-03-01T18:00:00.000Z'
    }
  ],
  keptSlots: 1
}

const overlay = {
  logo: defaultSponsorSettings.logo,
  reel: defaultSponsorSettings.reel
}

describe('api client sponsors', () => {
  it('calls each admin route and reads the whole state back', async () => {
    const { api, calls } = client(state)
    const row = {
      logoMediaId: 'smd_l',
      backgroundMediaId: 'smd_b',
      title: 'Harbor',
      message: 'Ten percent off.',
      url: 'https://harbor.example.test',
      textColor: 'white' as const,
      startsAt: '2027-04-01T18:00:00.000Z'
    }
    const answers = [
      await api.sponsorState('lea_a'),
      await api.addSponsorLogo('lea_a', {
        mediaId: 'smd_a',
        name: 'Harbor',
        allocation: 50
      }),
      await api.setSponsorLogoAllocation('slg_a', 60),
      await api.deactivateSponsorLogo('slg_a'),
      await api.addSponsorReel('lea_a', {
        mediaId: 'smd_r',
        name: 'Harbor',
        allocation: 100
      }),
      await api.setSponsorReelAllocation('srl_a', 120),
      await api.deactivateSponsorReel('srl_a'),
      await api.addSponsorRow('lea_a', row),
      await api.editSponsorRow('ser_a', { title: 'Harbor Two' }),
      await api.deleteSponsorRow('ser_a')
    ]
    for (const answer of answers) expect(answer).deep.equals(state)
    expect(calls.map(call => `${call.method} ${call.url}`)).deep.equals([
      'GET /api/v1/leagues/lea_a/sponsors',
      'POST /api/v1/leagues/lea_a/sponsors/logos',
      'PATCH /api/v1/sponsors/logos/slg_a',
      'POST /api/v1/sponsors/logos/slg_a/deactivate',
      'POST /api/v1/leagues/lea_a/sponsors/reels',
      'PATCH /api/v1/sponsors/reels/srl_a',
      'POST /api/v1/sponsors/reels/srl_a/deactivate',
      'POST /api/v1/leagues/lea_a/sponsors/rows',
      'PATCH /api/v1/sponsors/rows/ser_a',
      'DELETE /api/v1/sponsors/rows/ser_a'
    ])
    expect(calls[1].body).deep.equals({
      mediaId: 'smd_a',
      name: 'Harbor',
      allocation: 50
    })
    expect(calls[2].body).deep.equals({ allocation: 60 })
    expect(calls[7].body).deep.equals(row)
    expect(calls[8].body).deep.equals({ title: 'Harbor Two' })
  })

  it('sends an upload as its bytes with the type named, and reads the media back', async () => {
    const stored = {
      mediaId: 'smd_a',
      url: 'https://media.example.test/a.png',
      width: 480,
      height: 270,
      durationMs: null
    }
    const { api, calls } = client(stored)
    expect(
      await api.uploadSponsorMedia(
        'lea_a',
        'logo',
        'image/png',
        new Uint8Array([1, 2, 3])
      )
    ).deep.equals(stored)
    expect(calls).deep.equals([
      {
        url: '/api/v1/leagues/lea_a/sponsors/media?purpose=logo',
        method: 'POST',
        type: 'image/png',
        body: [1, 2, 3]
      }
    ])
  })

  it('reads the sample video, a recording or the node’s', async () => {
    const recording = {
      kind: 'recording',
      videoId: 'vid_a',
      url: 'https://app.example.test/api/v1/videos/vid_a/hls/master.m3u8?t=x',
      window: [1800, 1920],
      overlay
    }
    expect(await client(recording).api.sponsorSample('lea_a')).deep.equals(
      recording
    )
    const node = {
      kind: 'node',
      url: 'https://media.example.test/sponsors/sample/default.mp4',
      window: [0, 120],
      overlay
    }
    const { api, calls } = client(node)
    expect(await api.sponsorSample('lea_a')).deep.equals(node)
    expect(calls[0].url).equals('/api/v1/leagues/lea_a/sponsors/sample')
  })

  it('refuses a sample with a broken window or overlay', async () => {
    for (const bad of [
      { kind: 'node', url: 'x', window: [120, 0], overlay },
      { kind: 'node', url: 'x', window: [0], overlay },
      {
        kind: 'node',
        url: 'x',
        window: [0, 120],
        overlay: {
          ...overlay,
          logo: {
            ...overlay.logo,
            single: { ...overlay.logo.single, side: 1.2 }
          }
        }
      },
      {
        kind: 'node',
        url: 'x',
        window: [0, 120],
        overlay: {
          ...overlay,
          reel: {
            ...overlay.reel,
            landscape1: { maxWidth: -1, maxHeight: 0.3 }
          }
        }
      },
      { kind: 'node', url: 'x', window: [0, 120], overlay: null },
      { kind: 'recording', url: 'x', window: [0, 120], overlay }
    ])
      expect(
        await client(bad)
          .api.sponsorSample('lea_a')
          .then(
            () => 'accepted',
            () => 'refused'
          ),
        JSON.stringify(bad)
      ).equals('refused')
  })
})
