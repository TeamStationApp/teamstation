import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { meminfoArgs, parseMeminfo, sampleMeminfo } from './adbMeminfo'
import { jsHeapUsed, rendererPids, sampleChrome } from './chromeProcess'
import { sampleDroplet } from './droplet'
import { parsePsRss } from './sample'
import {
  exportArgs,
  exportTrace,
  parseProcessTable,
  parseXml,
  perMinute,
  recordArgs,
  samplesFromExport,
  WEB_CONTENT
} from './xctrace'

const fixture = (name: string): string =>
  readFileSync(join(__dirname, '..', 'fixtures', name), 'utf8')
const START = 1_800_000_000_000

describe('the xctrace sampler', function () {
  it('builds its record and export commands', function () {
    expect(
      recordArgs({
        udid: 'example-device-udid',
        attach: 'TeamStation Develop',
        output: '/tmp/a.trace'
      })
    ).deep.equals([
      'xctrace',
      'record',
      '--template',
      'Activity Monitor',
      '--device',
      'example-device-udid',
      '--attach',
      'TeamStation Develop',
      '--time-limit',
      '2h15m',
      '--output',
      '/tmp/a.trace'
    ])
    expect(recordArgs({ udid: 'x', output: 'o', timeLimit: '20m' })).includes(
      '--all-processes'
    )
    expect(exportArgs('/tmp/a.trace').at(-1)).equals(
      '/trace-toc/run[@number="1"]/data/table[@schema="activity-monitor-process-live"]'
    )
  })

  it('reads an app export, following refs and skipping sentinels', function () {
    const rows = parseProcessTable(fixture('xctraceApp.xml'))
    expect(
      rows.map(row => [row.atNs / 1e9, row.name, row.pid, row.bytes])
    ).deep.equals([
      [1, 'TeamStation Develop', 812, 188743680],
      [31, 'TeamStation Develop', 812, 199229440],
      [45, 'TeamStation Develop', 812, 209715200],
      [65, 'TeamStation Develop', 812, 209715200],
      [67, 'kernel_task & co', 0, 188743680]
    ])
    const samples = samplesFromExport(fixture('xctraceApp.xml'), {
      device: 'ipad',
      appName: 'TeamStation',
      traceStartMs: START
    })
    expect(samples).deep.equals([
      {
        device: 'ipad',
        process: 'TeamStation',
        atMs: START,
        bytes: 199229440,
        pid: 812
      },
      {
        device: 'ipad',
        process: 'TeamStation',
        atMs: START + 60_000,
        bytes: 209715200,
        pid: 812
      }
    ])
  })

  it('picks the WebContent process serving the tab from an all-process export', function () {
    const samples = samplesFromExport(fixture('xctraceAll.xml'), {
      device: 'iphone',
      appName: 'TeamStation',
      traceStartMs: START,
      webContent: { during: [[START, START + 10 * 60_000]] }
    })
    expect(
      samples.filter(s => s.process === WEB_CONTENT).map(s => [s.pid, s.bytes])
    ).deep.equals([
      [902, 320000000],
      [902, 330000000]
    ])
    expect(samples.filter(s => s.process === 'TeamStation')).length(2)
    const away = samplesFromExport(fixture('xctraceAll.xml'), {
      device: 'iphone',
      appName: 'TeamStation',
      traceStartMs: START,
      webContent: { during: [] }
    })
    expect(away.every(s => s.process === 'TeamStation')).equals(true)
  })

  it('refuses an export without what it needs, and reads plain XML', function () {
    expect(() => parseProcessTable('<trace-query-result/>')).throws(/no schema/)
    expect(() =>
      parseProcessTable(
        '<schema><col><mnemonic>start</mnemonic></col></schema>'
      )
    ).throws(/lacks a column/)
    const xml = parseXml(
      `<a x='1' y="&lt;2&gt;"><b>t &quot;q&quot; &apos;</b><c/></a></a>`
    )
    expect(xml.children[0].attrs).deep.equals({ x: '1', y: '<2>' })
    expect(xml.children[0].children[0].text).equals(`t "q" '`)
    expect(
      perMinute(
        [
          { atNs: 0, name: 'x', pid: null, bytes: 4 },
          { atNs: 1, name: 'x', pid: null, bytes: 6 }
        ],
        {
          device: 'd',
          process: 'p',
          traceStartMs: 0
        }
      )
    ).deep.equals([{ device: 'd', process: 'p', atMs: 0, bytes: 5 }])
    const noRow =
      '<schema><col><mnemonic>start</mnemonic></col><col><mnemonic>process</mnemonic></col><col><mnemonic>memory</mnemonic></col></schema><row><start-time>1</start-time></row>'
    expect(parseProcessTable(noRow)).deep.equals([])
  })

  it('exports through xcrun', async function () {
    const calls: unknown[] = []
    const xml = await exportTrace(async (command, args) => {
      calls.push([command, args[0]])
      return '<x/>'
    }, '/tmp/a.trace')
    expect(xml).equals('<x/>')
    expect(calls).deep.equals([['xcrun', 'xctrace']])
  })
})

describe('the adb meminfo sampler', function () {
  it('reads TOTAL PSS and the pid, on a new Android and an old one', function () {
    expect(parseMeminfo(fixture('meminfo.txt'))).deep.equals({
      pid: 23456,
      pssBytes: 312345 * 1024
    })
    expect(parseMeminfo(fixture('meminfoOld.txt'))).deep.equals({
      pid: 345,
      pssBytes: 100000 * 1024
    })
    expect(parseMeminfo('No process found for: app.example.develop')).equals(
      null
    )
    expect(parseMeminfo('nothing here')).equals(null)
    expect(parseMeminfo('        TOTAL   10')).deep.equals({
      pid: null,
      pssBytes: 10240
    })
    expect(meminfoArgs('emulator-0000', 'app.example.develop')).deep.equals([
      '-s',
      'emulator-0000',
      'shell',
      'dumpsys',
      'meminfo',
      'app.example.develop'
    ])
  })

  it('samples through adb', async function () {
    const samples = await sampleMeminfo(
      async command => {
        expect(command).equals('adb')
        return fixture('meminfo.txt')
      },
      {
        device: 'android',
        serial: 'emulator-0000',
        package: 'app.example.develop',
        process: 'TeamStation',
        now: () => 5
      }
    )
    expect(samples).deep.equals([
      {
        device: 'android',
        process: 'TeamStation',
        atMs: 5,
        bytes: 312345 * 1024,
        pid: 23456
      }
    ])
    expect(
      await sampleMeminfo(async () => 'No process found', {
        device: 'a',
        serial: 's',
        package: 'p',
        now: () => 0
      })
    ).deep.equals([])
    const noPid = await sampleMeminfo(async () => '  TOTAL 1', {
      device: 'a',
      serial: 's',
      package: 'p',
      now: () => 0
    })
    expect(noPid).deep.equals([
      { device: 'a', process: 'p', atMs: 0, bytes: 1024 }
    ])
  })
})

describe('the Chrome sampler', function () {
  it("takes the largest renderer's RSS and the page's JS heap", async function () {
    const sent: string[] = []
    const samples = await sampleChrome({
      browser: async method => {
        sent.push(method)
        return {
          processInfo: [
            { type: 'browser', id: 100, cpuTime: 1 },
            { type: 'renderer', id: 101, cpuTime: 1 },
            { type: 'renderer', id: 102, cpuTime: 1 }
          ]
        }
      },
      page: async method => {
        sent.push(method)
        return {
          metrics: [
            { name: 'Nodes', value: 9 },
            { name: 'JSHeapUsedSize', value: 4_000_000 }
          ]
        }
      },
      exec: async (command, args) => {
        expect([command, ...args]).deep.equals([
          'ps',
          '-o',
          'pid=,rss=',
          '-p',
          '101,102'
        ])
        return '  101  20000\n  102 250000\n'
      },
      now: () => 7
    })
    expect(samples).deep.equals([
      {
        device: 'chrome',
        process: 'renderer',
        atMs: 7,
        bytes: 250000 * 1024,
        pid: 102
      },
      { device: 'chrome', process: 'jsHeap', atMs: 7, bytes: 4_000_000 }
    ])
    expect(sent).deep.equals([
      'SystemInfo.getProcessInfo',
      'Performance.enable',
      'Performance.getMetrics'
    ])
  })

  it('samples nothing it cannot find', async function () {
    expect(rendererPids({})).deep.equals([])
    expect(jsHeapUsed({})).equals(null)
    const none = await sampleChrome({
      browser: async () => ({ processInfo: [{ type: 'renderer', id: 1 }] }),
      page: async () => ({}),
      exec: async () => '',
      now: () => 0
    })
    expect(none).deep.equals([])
    const noRenderer = await sampleChrome({
      browser: async () => ({}),
      page: async () => ({}),
      exec: async () => '',
      now: () => 0,
      device: 'c'
    })
    expect(noRenderer).deep.equals([])
  })
})

describe('the droplet sampler', function () {
  it("reads each process's pid by its own command, then its RSS", async function () {
    const samples = await sampleDroplet({
      exec: async (command, args) => {
        if (command === 'pid-of')
          return args[0] === 'api'
            ? '4100\n'
            : args[0] === 'ingest'
              ? '4200\n'
              : '0\n'
        return '4100 81920\n4200 40960\n9999 1\n'
      },
      processes: [
        { process: 'api', pidCommand: ['pid-of', 'api'] },
        { process: 'ingest', pidCommand: ['pid-of', 'ingest'] },
        { process: 'stopped', pidCommand: ['pid-of', 'other'] }
      ],
      now: () => 3
    })
    expect(samples).deep.equals([
      {
        device: 'stack',
        process: 'api',
        atMs: 3,
        bytes: 81920 * 1024,
        pid: 4100
      },
      {
        device: 'stack',
        process: 'ingest',
        atMs: 3,
        bytes: 40960 * 1024,
        pid: 4200
      }
    ])
    expect(
      await sampleDroplet({
        exec: async () => '',
        processes: [{ process: 'api', pidCommand: ['pid-of', 'a'] }],
        now: () => 0
      })
    ).deep.equals([])
    expect(parsePsRss('junk\n 1 2')).deep.equals(new Map([[1, 2048]]))
  })
})
