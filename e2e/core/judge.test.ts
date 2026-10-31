import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { PNG } from 'pngjs'

import { Checkpoints, statusFromCheckpoints } from './checkpoint'
import {
  addToCorpus,
  blankCopy,
  clippedCopy,
  logItem,
  readCorpus,
  scoreJudge,
  screenItems,
  shiftedCopy
} from './corpus'
import {
  Budget,
  downscale,
  HAIKU,
  haikuJudge,
  type Judge,
  type JudgeAnswer,
  judgeHasAuthority,
  type MessagesClient,
  readJudgeBar,
  SONNET,
  writeJudgeBar
} from './judge'
import {
  contactSheet,
  measureVideo,
  parseMeasurement,
  videoProblems
} from './video'

function png(width = 40, height = 40): Buffer {
  const image = new PNG({ width, height })
  for (let at = 0; at < image.data.length; at += 4) {
    const line = Math.floor(at / 4 / width) === 2
    image.data[at] = line ? 0 : 255
    image.data[at + 1] = line ? 0 : 255
    image.data[at + 2] = line ? 0 : 255
    image.data[at + 3] = 255
  }
  return PNG.sync.write(image)
}

function replying(
  ...replies: Array<Record<string, unknown> | 'refusal' | 'garbage'>
): { client: MessagesClient; bodies: Array<Record<string, any>> } {
  const bodies: Array<Record<string, any>> = []
  return {
    bodies,
    client: {
      messages: {
        create: async body => {
          bodies.push(body)
          const reply = replies[bodies.length - 1]
          const usage = { input_tokens: 2000, output_tokens: 100 }
          if (reply === 'refusal') {
            return { content: [], stop_reason: 'refusal', usage }
          }
          const text = reply === 'garbage' ? 'not json' : JSON.stringify(reply)
          return {
            content: [{ type: 'text', text }],
            stop_reason: 'end_turn',
            usage
          }
        }
      }
    }
  }
}

const SURE_PASS = { verdict: 'pass', confidence: 0.95, observed: 'all there' }
const SURE_FAIL = { verdict: 'fail', confidence: 0.95, observed: 'blank' }
const DOUBT = { verdict: 'unsure', confidence: 0.3, observed: 'hard to say' }
const shrink = (bytes: Uint8Array): Buffer => Buffer.from(bytes)
const IMAGE = { kind: 'image', png: png() } as const

describe('the Haiku judge', function () {
  it('asks each model in its own form, with the image first', async function () {
    const { client, bodies } = replying(DOUBT, SURE_PASS)
    const answer = await haikuJudge(client, shrink).ask(
      'The score reads 3',
      IMAGE,
      new Budget(1)
    )
    const [haiku, sonnet] = bodies
    expect(haiku.model).equals('claude-haiku-5-5')
    expect(haiku.thinking).deep.equals({ type: 'disabled' })
    expect(haiku.output_config.effort).equals('low')
    expect(haiku.output_config.format.type).equals('json_schema')
    expect(haiku.messages[0].content[0].type).equals('image')
    expect(haiku.messages[0].content[0].source.media_type).equals('image/png')
    expect(haiku.messages[0].content[1].text).equals('The score reads 3')
    expect(sonnet.model).equals('claude-sonnet-5-5')
    expect(sonnet.thinking).deep.equals({ type: 'between_tools' })
    expect(answer?.escalated).equals(true)
    expect(answer?.verdict).equals('pass')
  })

  it('takes a sure answer without escalating, at its measured cost', async function () {
    const { client, bodies } = replying(SURE_FAIL)
    const budget = new Budget(1)
    const answer = await haikuJudge(client, shrink).ask('Q', IMAGE, budget)
    expect(bodies.length).equals(1)
    expect(answer?.verdict).equals('fail')
    expect(answer?.costUsd).closeTo(
      (2000 * HAIKU.inputPerMillion + 100 * HAIKU.outputPerMillion) / 1e6,
      1e-9
    )
    expect(budget.spentUsd).closeTo(answer?.costUsd ?? 0, 1e-9)
  })

  it('escalates once, and stays unsure when the second model doubts too', async function () {
    const { client, bodies } = replying(DOUBT, DOUBT)
    const answer = await haikuJudge(client, shrink).ask(
      'Q',
      IMAGE,
      new Budget(1)
    )
    expect(bodies.length).equals(2)
    expect(answer?.verdict).equals('unsure')
    const low = replying(DOUBT, { ...SURE_PASS, confidence: 0.2 })
    const lowAnswer = await haikuJudge(low.client, shrink).ask(
      'Q',
      IMAGE,
      new Budget(1)
    )
    expect(lowAnswer?.verdict).equals('unsure')
    expect(lowAnswer?.costUsd).greaterThan(
      (2000 * SONNET.inputPerMillion) / 1e6
    )
  })

  it('treats a refusal or an unreadable reply as unsure', async function () {
    for (const reply of ['refusal', 'garbage', { verdict: 'maybe' }] as const) {
      const { client, bodies } = replying(reply, reply)
      const answer = await haikuJudge(client, shrink).ask(
        'Q',
        IMAGE,
        new Budget(1)
      )
      expect(answer?.verdict).equals('unsure')
      expect(bodies.length).equals(2)
    }
    const partial = replying({ verdict: 'pass' }, DOUBT)
    expect(
      (await haikuJudge(partial.client, shrink).ask('Q', IMAGE, new Budget(1)))
        ?.verdict
    ).equals('unsure')
  })

  it('judges a log as text', async function () {
    const { client, bodies } = replying(SURE_PASS)
    await haikuJudge(client, shrink).ask(
      'Did it fail?',
      { kind: 'text', text: 'all green' },
      new Budget(1)
    )
    expect(bodies[0].messages[0].content[0].text).includes('all green')
  })

  it('makes no call without budget, and reports what it could not afford', async function () {
    const { client, bodies } = replying(SURE_PASS)
    const judge = haikuJudge(client, shrink)
    expect(await judge.ask('Q', IMAGE, new Budget())).equals(undefined)
    expect(await judge.ask('Q', IMAGE, new Budget(0))).equals(undefined)
    expect(await judge.annotate(png(), new Budget(0))).equals(undefined)
    expect(bodies.length).equals(0)
    // Enough for Haiku but not the escalation: the doubt stands, unescalated.
    const doubting = replying(DOUBT)
    const answer = await haikuJudge(doubting.client, shrink).ask(
      'Q',
      IMAGE,
      new Budget(0.001)
    )
    expect(answer?.verdict).equals('unsure')
    expect(answer?.escalated).equals(false)
    expect(doubting.bodies.length).equals(1)
  })

  it('labels a mismatch, and has no answer for an unreadable one', async function () {
    const { client, bodies } = replying({
      label: 'layout-regression',
      region: 'the header'
    })
    const note = await haikuJudge(client, shrink).annotate(png(), new Budget(1))
    expect(note?.label).equals('layout-regression')
    expect(note?.region).equals('the header')
    expect(bodies[0].output_config.format.schema.required).includes('label')
    const none = replying('garbage')
    expect(
      await haikuJudge(none.client, shrink).annotate(png(), new Budget(1))
    ).equals(undefined)
    const bare = replying({ label: 'content-change' })
    expect(
      (await haikuJudge(bare.client, shrink).annotate(png(), new Budget(1)))
        ?.region
    ).equals('')
  })

  it('downscales a large screen and leaves a small one alone', function () {
    const large = PNG.sync.read(downscale(png(1206, 2622)))
    expect(large.width).lessThanOrEqual(828)
    expect(large.height).lessThanOrEqual(1792)
    expect(PNG.sync.read(downscale(png(40, 40))).width).equals(40)
    expect(() => downscale(Buffer.from('not an image'))).to.throw(
      'could not downscale'
    )
  })
})

function fakeJudge(answer: Partial<JudgeAnswer> | 'throw' | 'spent'): Judge {
  return {
    id: 'fake',
    ask: async () => {
      if (answer === 'throw') throw new Error('service down')
      if (answer === 'spent') return undefined
      return {
        verdict: 'pass',
        confidence: 1,
        observed: 'seen',
        model: 'm',
        escalated: false,
        costUsd: 0.001,
        latencyMs: 1,
        ...answer
      }
    },
    annotate: async () => ({
      label: 'rendering-noise',
      region: 'all',
      costUsd: 0.001
    })
  }
}

function device(over: Record<string, unknown> = {}): any {
  return {
    hierarchy: async () => ({ children: [{ text: 'Sox' }] }),
    screenshot: async () => png(),
    state: async () => ({}),
    getConsoleLogs: async () => ({ data: '[]' }),
    assertVisible: async () => ({}),
    assertNotVisible: async () => ({}),
    ...over
  }
}

function checkpoints(
  judges?: ConstructorParameters<typeof Checkpoints>[0]['judges']
): Checkpoints {
  return new Checkpoints({
    scenarioId: 'a/b/c#d',
    surface: 'web-chromium',
    runDir: mkdtempSync(join(tmpdir(), 'ask-run-')),
    root: mkdtempSync(join(tmpdir(), 'ask-root-')),
    settings: {},
    serverErrors: async () => [],
    alone: true,
    worldIds: () => [],
    ...(judges == null ? {} : { judges })
  })
}

const target = (over: Record<string, unknown> = {}): any => ({
  device: device(over),
  deviceClass: 'x',
  consoleSeen: 0
})

async function asked(
  judges: ConstructorParameters<typeof Checkpoints>[0]['judges']
): Promise<ReturnType<typeof statusFromCheckpoints> & { record: any }> {
  const run = checkpoints(judges)
  await run.check('screen', { ask: 'The score reads 3' }, target())
  return { ...statusFromCheckpoints(run.records), record: run.records[0] }
}

describe('an AI ask in a checkpoint', function () {
  it('passes on a pass, recorded as inferred', async function () {
    const { status, record } = await asked({
      judge: fakeJudge({}),
      budget: new Budget(1),
      authoritative: false
    })
    expect(status).equals('passed')
    expect(record.ask.basis).equals('INFERRED')
    expect(record.ask.costUsd).equals(0.001)
  })

  it('fails only when the judge has reached the bar', async function () {
    const below = await asked({
      judge: fakeJudge({ verdict: 'fail', observed: 'blank' }),
      budget: new Budget(1),
      authoritative: false
    })
    expect(below.status).equals('needs-review')
    expect(below.reason).includes('has not reached the bar')
    const at = await asked({
      judge: fakeJudge({ verdict: 'fail', observed: 'blank' }),
      budget: new Budget(1),
      authoritative: true
    })
    expect(at.status).equals('failed')
    expect(at.reason).includes('blank')
  })

  it('reports needs-review, never a pass, for doubt, no budget, no key or an error', async function () {
    const cases = [
      { judge: fakeJudge({ verdict: 'unsure' }), detail: 'seen' },
      { judge: fakeJudge('spent'), detail: 'budget is spent' },
      { judge: undefined, detail: 'no judge' },
      { judge: fakeJudge('throw'), detail: 'service down' }
    ]
    for (const row of cases) {
      const { status, reason } = await asked({
        judge: row.judge,
        budget: new Budget(1),
        authoritative: true
      })
      expect(status).equals('needs-review')
      expect(reason).includes(row.detail)
    }
    const run = checkpoints()
    await run.check('screen', { ask: 'Q' }, target())
    expect(statusFromCheckpoints(run.records).status).equals('needs-review')
  })

  it('never turns a golden failure green, whatever its annotation says', async function () {
    const run = checkpoints({
      judge: fakeJudge({ verdict: 'pass' }),
      budget: new Budget(1),
      authoritative: true
    })
    const diff = join(mkdtempSync(join(tmpdir(), 'diff-')), 'diff.png')
    writeFileSync(diff, png())
    await run.check(
      'screen',
      { golden: {}, ask: 'Looks right' },
      target({
        assertScreenshot: async () => {
          throw Object.assign(new Error('moved'), {
            code: 'COMMAND_FAILED',
            result: { data: { diffPath: diff } }
          })
        }
      })
    )
    const [record] = run.records
    expect(record.annotation?.label).equals('rendering-noise')
    expect(record.ask?.verdict).equals('pass')
    expect(record.visual?.verdict).equals('fail')
    expect(statusFromCheckpoints(run.records).status).equals('failed')
  })

  it('leaves the verdict alone when an annotation fails', async function () {
    const judge = fakeJudge({})
    judge.annotate = async () => {
      throw new Error('service down')
    }
    const run = checkpoints({
      judge,
      budget: new Budget(1),
      authoritative: true
    })
    const diff = join(mkdtempSync(join(tmpdir(), 'diff-')), 'diff.png')
    writeFileSync(diff, png())
    const error = console.error
    console.error = () => {}
    try {
      await run.check(
        'screen',
        { golden: {} },
        target({
          assertScreenshot: async () => {
            throw Object.assign(new Error('moved'), {
              code: 'COMMAND_FAILED',
              result: { data: { diffPath: diff } }
            })
          }
        })
      )
    } finally {
      console.error = error
    }
    expect(run.records[0].annotation).equals(undefined)
    expect(statusFromCheckpoints(run.records).status).equals('failed')
  })
})

describe('judge-eval', function () {
  const item = (
    cls: string,
    expected: 'pass' | 'fail'
  ): {
    file: string
    class: any
    expected: 'pass' | 'fail'
    question: string
  } => ({
    file: cls,
    class: cls,
    expected,
    question: 'Q'
  })

  function perfectOn(wrong: string[] = []): Judge {
    return {
      id: 'fake',
      annotate: async () => undefined,
      ask: async (_question, input) => {
        const text = input.kind === 'text' ? input.text : ''
        const truth = text.startsWith('fail') ? 'fail' : 'pass'
        const flip = wrong.some(name => text.endsWith(name))
        return {
          verdict: flip ? (truth === 'fail' ? 'pass' : 'fail') : truth,
          confidence: 1,
          observed: '',
          model: 'm',
          escalated: false,
          costUsd: 0.5,
          latencyMs: 2
        }
      }
    }
  }

  const read = (row: { class: string; expected: string }): any => ({
    kind: 'text',
    text: `${row.expected} ${row.class}`
  })

  it('computes precision, recall, cost and latency, and the bar', async function () {
    const corpus = {
      items: [
        item('clean', 'pass'),
        item('blank', 'fail'),
        item('shifted', 'fail')
      ]
    }
    const score = await scoreJudge(perfectOn(), corpus, read, new Budget(10))
    expect(score.recall).equals(1)
    expect(score.precision).equals(1)
    expect(score.falseFailures).equals(0)
    expect(score.costUsd).equals(1.5)
    expect(score.latencyMs).equals(6)
    expect(score.passed).equals(true)
    expect(score.classes.blank).deep.equals({ total: 1, correct: 1, unsure: 0 })
  })

  it('fails the bar on a missed defect or a false failure', async function () {
    const corpus = { items: [item('clean', 'pass'), item('blank', 'fail')] }
    const missed = await scoreJudge(
      perfectOn(['blank']),
      corpus,
      read,
      new Budget(10)
    )
    expect(missed.recall).equals(0)
    expect(missed.precision).equals(0)
    expect(missed.passed).equals(false)
    const wrong = await scoreJudge(
      perfectOn(['clean']),
      corpus,
      read,
      new Budget(10)
    )
    expect(wrong.falseFailures).equals(1)
    expect(wrong.passed).equals(false)
  })

  it('cannot pass by doubting, by running out of budget, or on a one-sided corpus', async function () {
    const doubting: Judge = {
      ...perfectOn(),
      ask: async () => ({
        verdict: 'unsure',
        confidence: 0,
        observed: '',
        model: 'm',
        escalated: false,
        costUsd: 0,
        latencyMs: 0
      })
    }
    const corpus = { items: [item('clean', 'pass'), item('blank', 'fail')] }
    const doubted = await scoreJudge(doubting, corpus, read, new Budget(10))
    expect(doubted.passed).equals(false)
    expect(doubted.classes.blank.unsure).equals(1)
    const broke: Judge = { ...perfectOn(), ask: async () => undefined }
    const unpaid = await scoreJudge(broke, corpus, read, new Budget(0))
    expect(unpaid.notScored).equals(2)
    expect(unpaid.passed).equals(false)
    const onlyClean = await scoreJudge(
      perfectOn(),
      { items: [item('clean', 'pass')] },
      read,
      new Budget(10)
    )
    expect(onlyClean.passed).equals(false)
    const onlyDefects = await scoreJudge(
      perfectOn(),
      { items: [item('blank', 'fail')] },
      read,
      new Budget(10)
    )
    expect(onlyDefects.passed).equals(false)
  })

  it('records the bar, and gives authority only to a judge that passed', function () {
    const root = mkdtempSync(join(tmpdir(), 'bar-'))
    expect(readJudgeBar(root)).deep.equals({ judges: {} })
    expect(judgeHasAuthority(root, 'haiku')).equals(false)
    const record = {
      recall: 1,
      falseFailures: 0,
      model: 'm',
      date: '2026-10-31'
    }
    writeJudgeBar(root, {
      judges: {
        haiku: { ...record, passed: true },
        other: { ...record, passed: false }
      }
    })
    expect(judgeHasAuthority(root, 'haiku')).equals(true)
    expect(judgeHasAuthority(root, 'other')).equals(false)
  })
})

describe('the corpus', function () {
  function store(): string {
    const dir = mkdtempSync(join(tmpdir(), 'corpus-'))
    const env = { ...process.env }
    for (const name of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE']) {
      env[name] = undefined
    }
    const origin = join(dir, 'origin.git')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'master', origin], {
      env
    })
    const path = join(dir, 'store')
    execFileSync('git', ['clone', '-q', origin, path], { env, stdio: 'ignore' })
    for (const [name, value] of [
      ['user.name', 'Pat Neshek'],
      ['user.email', 'pat@example.test']
    ]) {
      execFileSync('git', ['config', name, value], { cwd: path, env })
    }
    return path
  }

  it('makes each corruption from one clean screen', function () {
    const clean = png()
    const read = (bytes: Uint8Array): PNG => PNG.sync.read(Buffer.from(bytes))
    expect(new Set(read(blankCopy(clean)).data).size).equals(1)
    const clipped = read(clippedCopy(clean))
    expect(clipped.data[(39 * 40 + 1) * 4]).equals(0)
    expect(clipped.data[1 * 4]).equals(255)
    const shifted = read(shiftedCopy(clean))
    // The dark line at row 2 moved down by a tenth of the 40 rows.
    expect(shifted.data[(2 * 40 + 1) * 4]).equals(255)
    expect(shifted.data[(6 * 40 + 1) * 4]).equals(0)
    const items = screenItems(clean, 'Score is 3', 'Score is 9', png(20, 20))
    expect(items.map(row => row.class)).deep.equals([
      'clean',
      'blank',
      'clipped',
      'shifted',
      'wrong-text',
      'error-dialog'
    ])
    expect(items[0].expected).equals('pass')
    expect(items.slice(1).every(row => row.expected === 'fail')).equals(true)
    expect(items[4].question).equals('Score is 9')
  })

  it('stores items in the private store, once each, with logs redacted', function () {
    const path = store()
    expect(readCorpus(path)).deep.equals({ items: [] })
    const log = logItem('password=hunter2 boom', 'fail', 'Did it fail?')
    expect(String(log.bytes)).not.includes('hunter2')
    expect(log.class).equals('failed-log')
    expect(logItem('fine', 'pass', 'Q').class).equals('clean-log')
    const files = screenItems(png(), 'A', 'B', png(20, 20))
    expect(addToCorpus(path, [...files, log])).equals(7)
    expect(addToCorpus(path, files)).equals(0)
    const { items } = readCorpus(path)
    expect(items.length).equals(7)
    expect(items[0].file).matches(/^corpus\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/)
    expect(readFileSync(join(path, items[0].file)).equals(png())).equals(true)
    expect(items[6].file.endsWith('.txt')).equals(true)
  })
})

describe('video measurements', function () {
  const dir = mkdtempSync(join(tmpdir(), 'video-'))
  const clip = (name: string, ...args: string[]): string => {
    const out = join(dir, name)
    const run = spawnSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      ...args,
      '-t',
      '3',
      '-pix_fmt',
      'yuv420p',
      '-shortest',
      out
    ])
    expect(run.status, String(run.stderr)).equals(0)
    return out
  }
  const SOURCE = ['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10']
  const TONE = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000']

  it('passes a clean clip', function () {
    const measured = measureVideo(clip('clean.mp4', ...SOURCE, ...TONE))
    expect(videoProblems(measured, { expectAudio: true })).deep.equals([])
    expect(measured.hasAudio).equals(true)
    expect(measured.durationSec).greaterThan(2)
  })

  it('flags a frozen clip', function () {
    const frozen = clip(
      'frozen.mp4',
      '-f',
      'lavfi',
      '-i',
      'color=c=gray:size=160x120:rate=10,drawbox=x=10:y=10:w=40:h=40:color=red'
    )
    const problems = videoProblems(measureVideo(frozen))
    expect(problems.join()).includes('frozen')
  })

  it('flags a black clip', function () {
    const black = clip(
      'black.mp4',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:size=160x120:rate=10'
    )
    expect(videoProblems(measureVideo(black)).join()).includes('black')
  })

  it('flags a silent clip, and a clip with no audio when it wants some', function () {
    const silent = clip(
      'silent.mp4',
      ...SOURCE,
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=8000:cl=mono'
    )
    expect(videoProblems(measureVideo(silent)).join()).includes('silent')
    const mute = clip('mute.mp4', ...SOURCE)
    const measured = measureVideo(mute)
    expect(measured.hasAudio).equals(false)
    expect(videoProblems(measured)).deep.equals([])
    expect(videoProblems(measured, { expectAudio: true })).deep.equals([
      'no audio track'
    ])
  })

  it('refuses a file it cannot read, and reads an open-ended interval', function () {
    const bad = join(dir, 'bad.mp4')
    writeFileSync(bad, 'not a video')
    expect(() => measureVideo(bad)).to.throw('could not read')
    expect(() => {
      contactSheet(bad, join(dir, 'x.png'))
    }).to.throw('could not sheet')
    const open = parseMeasurement(
      'Duration: 00:00:05.00, start\nfreeze_start: 2.5\n'
    )
    expect(open.frozen).deep.equals([{ start: 2.5, end: 5 }])
    expect(parseMeasurement('nothing').durationSec).equals(0)
  })

  it('makes a contact sheet for a judge', function () {
    const out = join(dir, 'sheet.png')
    mkdirSync(dir, { recursive: true })
    contactSheet(clip('sheet.mp4', ...SOURCE), out)
    expect(PNG.sync.read(readFileSync(out)).width).equals(1440)
  })
})
