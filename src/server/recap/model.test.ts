import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  asGameRecap,
  asRecapDocument,
  recapPlay,
  validateRecap
} from '../../common/gameRecap'
import { asGumboPlay } from '../../common/gumboPlay'
import { type RecapInput, recapWriter } from './model'

export const recapDocument = {
  headline: 'Owls win 4–2 over Herons',
  dateLine: 'January 1, 2026',
  paragraphs: [
    [
      {
        text: 'A single opened the scoring.',
        kind: 'play' as const,
        plays: [0]
      }
    ]
  ]
}
const input: RecapInput = {
  homeTeam: 'Owls',
  awayTeam: 'Herons',
  date: 'January 1, 2026',
  homeScore: 4,
  awayScore: 2,
  plays: [
    asGumboPlay({ about: { atBatIndex: 0 }, result: { eventType: 'single' } })
  ]
}
const signal = new AbortController().signal
const answer =
  (value: unknown): typeof fetch =>
  async () =>
    new Response(JSON.stringify(value))
async function fails(work: Promise<unknown>): Promise<void> {
  try {
    await work
  } catch {
    return
  }
  throw new Error('Expected failure')
}

describe('recap model and document contract', () => {
  it('uses only its dedicated key, requested model, medium effort and supplied timeline', async () => {
    let sent: RequestInit | undefined
    let url = ''
    const fetcher = (async (u: string, init: RequestInit) => {
      url = u
      sent = init
      return new Response(
        JSON.stringify({
          stop_reason: 'end_turn',
          content: [
            { type: 'thinking' },
            { type: 'text', text: JSON.stringify(recapDocument) }
          ]
        })
      )
    }) as typeof fetch
    expect(
      await recapWriter(
        {
          apiKey: 'fixture-placeholder',
          baseUrl: 'https://model.example.test/v1/'
        },
        fetcher
      )(input, signal)
    ).deep.equals(recapDocument)
    expect(url).equals('https://model.example.test/v1/messages')
    expect(sent?.headers).includes({ 'x-api-key': 'fixture-placeholder' })
    if (typeof sent?.body !== 'string') throw new Error('Expected JSON body')
    const body = JSON.parse(sent.body)
    expect(body.model).equals('claude-sonnet-5-5')
    expect(body.output_config.effort).equals('medium')
    // Anthropic rejects numeric minimum constraints; validate indexes locally.
    expect(
      body.output_config.format.schema.properties.paragraphs.items.items
        .properties.plays.items
    ).deep.equals({ type: 'integer' })
    expect(JSON.parse(body.messages[0].content)).deep.equals(
      JSON.parse(JSON.stringify(input))
    )
    expect(body.system).includes('Never invent quotes')
    await fails(recapWriter({}, fetcher)(input, signal))
    await fails(recapWriter({ apiKey: ' ' }, fetcher)(input, signal))
  })
  it('rejects model failures, truncation, malformed data and fabricated references', async () => {
    await fails(
      recapWriter(
        { apiKey: 'fixture-placeholder' },
        async () => new Response('', { status: 503 })
      )(input, signal)
    )
    for (const response of [
      {},
      { stop_reason: 'max_tokens', content: [] },
      { stop_reason: 'end_turn', content: [] },
      {
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'not json' }]
      },
      {
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ...recapDocument,
              paragraphs: [[{ text: 'A play.', kind: 'play', plays: [99] }]]
            })
          }
        ]
      }
    ])
      await fails(
        recapWriter({ apiKey: 'fixture-placeholder' }, answer(response))(
          input,
          signal
        )
      )
  })
  it('validates bounded structured prose and never links summaries or totals', () => {
    expect(validateRecap(recapDocument, new Set([0]))).deep.equals(
      recapDocument
    )
    expect(recapPlay(recapDocument.paragraphs[0][0])).equals(0)
    for (const s of [
      { text: 'Total.', kind: 'totals' as const, plays: [0] },
      { text: 'Summary.', kind: 'summary' as const, plays: [0] },
      { text: 'Two plays.', kind: 'play' as const, plays: [0, 1] },
      { text: 'No source.', kind: 'play' as const, plays: [] }
    ])
      expect(recapPlay(s)).equals(null)
    for (const raw of [
      { ...recapDocument, headline: '' },
      { ...recapDocument, headline: 'x'.repeat(2001) },
      { ...recapDocument, paragraphs: [] },
      { ...recapDocument, paragraphs: [[]] },
      {
        ...recapDocument,
        paragraphs: Array(31).fill(recapDocument.paragraphs[0])
      },
      ...[-1, 0.5].map(p => ({
        ...recapDocument,
        paragraphs: [[{ text: 'Play.', kind: 'play', plays: [p] }]]
      })),
      {
        ...recapDocument,
        paragraphs: [[{ text: 'Play.', kind: 'play', plays: [0, 0] }]]
      }
    ])
      expect(() => asRecapDocument(raw)).throws()
    expect(
      asGameRecap({
        status: 'ready',
        document: recapDocument,
        clips: { '0': { videoId: 'vid_demo', start: 0, end: 10 } }
      }).status
    ).equals('ready')
    expect(
      asGameRecap({ status: 'pending', document: null, clips: {} }).document
    ).equals(null)
    for (const clips of [
      null,
      [],
      { bad: { videoId: 'v', start: 0, end: 1 } },
      { '0': { videoId: 'v', start: -1, end: 1 } },
      { '0': { videoId: 'v', start: 3, end: 1 } },
      { '0': { videoId: 'v', start: Infinity, end: 1 } }
    ])
      expect(() =>
        asGameRecap({ status: 'pending', document: null, clips })
      ).throws()
    expect(() =>
      asGameRecap({ status: 'ready', document: null, clips: {} })
    ).throws()
  })
})
