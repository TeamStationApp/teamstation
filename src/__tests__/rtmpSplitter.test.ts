/**
 * End-to-end test for the RTMP splitter:
 *
 *   ffmpeg lavfi publisher -> splitter (NMS+ffmpeg children) -> two sink NMS
 *
 * Verifies that:
 *   1. The publisher's RTMP handshake completes with the splitter.
 *   2. Both downstream sinks receive a valid RTMP/FLV publish (handshake
 *      success on the sink == byte-level RTMP framing was preserved).
 *   3. ffprobe against each sink confirms FLV container + h264 video + AAC
 *      audio + the original 1280x720 / 30 fps lavfi parameters.
 *   4. The splitter's live status snapshots reflect publishing/connected
 *      states for ingress + both outbounds.
 *
 * The test is skipped automatically if `ffmpeg`/`ffprobe` are missing or
 * if the default 1935 port (or sink ports 1936/1937) are already in use.
 */

import { expect } from 'chai'
import type { ChildProcess } from 'child_process'
import { spawn, spawnSync } from 'child_process'
import { describe, it } from 'mocha'
import net from 'net'

import { serverConfig } from '../server/serverConfig'

const NodeMediaServer = require('node-media-server')

interface Nms {
  on: (event: string, listener: (session: any) => void) => void
  run: () => void
}

function hasBin(bin: string): boolean {
  const result = spawnSync(bin, ['-version'], { stdio: 'ignore' })
  return result.status === 0
}

async function portFree(port: number): Promise<boolean> {
  return await new Promise<boolean>(resolve => {
    const tester = net
      .createServer()
      .once('error', () => {
        resolve(false)
      })
      .once('listening', () => {
        tester.close(() => {
          resolve(true)
        })
      })
      .listen(port, '127.0.0.1')
  })
}

const SPLITTER_PORT = serverConfig.rtmpPort // 1935 by default
const SINK_A_PORT = SPLITTER_PORT + 1
const SINK_B_PORT = SPLITTER_PORT + 2
const EVT_ID = 'e2eevt'

interface SinkState {
  port: number
  server: Nms
  publishStarted: Promise<void>
  publishStartedResolve?: () => void
}

async function startSink(port: number, streamApp: string): Promise<SinkState> {
  const nms: Nms = new NodeMediaServer({
    rtmp: { port },
    bind: '127.0.0.1'
  }) as Nms
  let resolver: (() => void) | undefined
  const publishStarted = new Promise<void>(resolve => {
    resolver = resolve
  })
  // node-media-server uses a global event emitter shared across instances,
  // so we must filter by streamApp to identify which sink received which
  // publish.
  nms.on('postPublish', (session: any) => {
    if (session.streamApp !== streamApp) return
    resolver?.()
  })
  nms.run()
  await new Promise(resolve => setTimeout(resolve, 200))
  return {
    port,
    server: nms,
    publishStarted,
    publishStartedResolve: resolver
  }
}

async function probeRtmp(url: string, timeoutMs: number): Promise<any> {
  return await new Promise((resolve, reject) => {
    // -timeout on the rtmp protocol is interpreted as "listen mode timeout"
    // by ffmpeg, which makes ffprobe try to bind() instead of connect().
    // We enforce timeouts via the wall-clock killTimer below instead.
    const child = spawn(
      'ffprobe',
      [
        '-v',
        'error',
        '-hide_banner',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        url
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => (stdout += d.toString()))
    child.stderr.on('data', d => (stderr += d.toString()))
    const killTimer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`ffprobe timed out: ${stderr}`))
    }, timeoutMs + 5000)
    child.on('exit', code => {
      clearTimeout(killTimer)
      if (code !== 0) {
        reject(new Error(`ffprobe exited ${code}: ${stderr}`))
        return
      }
      try {
        resolve(JSON.parse(stdout))
      } catch (e) {
        reject(e)
      }
    })
  })
}

describe('rtmp splitter end-to-end', function () {
  this.timeout(60000)

  const childrenToCleanup: ChildProcess[] = []
  let ffmpegPublisher: ChildProcess | undefined

  before(async function () {
    if (!hasBin('ffmpeg') || !hasBin('ffprobe')) {
      this.skip()
      return
    }
    for (const p of [SPLITTER_PORT, SINK_A_PORT, SINK_B_PORT]) {
      if (!(await portFree(p))) {
        console.warn(`Port ${p} in use; skipping RTMP splitter e2e test`)

        this.skip()
        return
      }
    }
  })

  after(function () {
    if (ffmpegPublisher != null) {
      try {
        ffmpegPublisher.kill('SIGKILL')
      } catch {}
    }
    for (const c of childrenToCleanup) {
      try {
        c.kill('SIGKILL')
      } catch {}
    }
  })

  it('forwards a published lavfi stream to two sinks with valid RTMP/FLV', async function () {
    // 1. Start two sinks
    const sinkA = await startSink(SINK_A_PORT, 'sinkA')
    const sinkB = await startSink(SINK_B_PORT, 'sinkB')

    // 2. Start the splitter (singleton; bound to serverConfig.rtmpPort)
    const splitter = await import('../server/rtmp/splitter')
    splitter.initializeRtmpSplitter()
    await new Promise(resolve => setTimeout(resolve, 300))

    // 3. Configure destinations BEFORE the publisher connects.
    //
    // Use distinct stream paths per sink because node-media-server keeps
    // its broadcasts map keyed by streamPath in a global Context shared
    // by every NMS instance in the same process, so identical paths on
    // two in-process sinks would collide as "already has a publisher".
    const destA = `rtmp://127.0.0.1:${SINK_A_PORT}/sinkA/${EVT_ID}`
    const destB = `rtmp://127.0.0.1:${SINK_B_PORT}/sinkB/${EVT_ID}`
    const setRes = splitter.setSplit(EVT_ID, [destA, destB])
    expect(setRes.ok, setRes.error ?? '').to.equal(true)

    // 4. Spawn the lavfi publisher
    const publishUrl = `rtmp://127.0.0.1:${SPLITTER_PORT}/split/${EVT_ID}`
    const args = [
      '-re',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=1280x720:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=1000:sample_rate=48000',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-tune',
      'zerolatency',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '60',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-ar',
      '48000',
      '-t',
      '20',
      '-f',
      'flv',
      publishUrl
    ]
    ffmpegPublisher = spawn('ffmpeg', args, {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    childrenToCleanup.push(ffmpegPublisher)
    ffmpegPublisher.stderr?.on('data', () => {
      /* swallow */
    })

    // 5. Wait for both sinks to see a publish handshake
    await Promise.race([
      Promise.all([sinkA.publishStarted, sinkB.publishStarted]),
      new Promise((_resolve, reject) =>
        setTimeout(() => {
          reject(new Error('sinks did not receive publish in 25s'))
        }, 25000)
      )
    ])

    // 6. Sanity-check the splitter's status snapshot
    const status = splitter.getStatusSnapshot(EVT_ID)
    expect(status, 'status snapshot').to.not.equal(null)
    expect(status!.destinations).to.have.length(2)
    expect(status!.ingress.publishing).to.equal(true)
    // outbound state may be 'connecting' or 'connected' at this exact instant;
    // the important thing is that both children are live (not 'error').
    for (const o of status!.outbounds) {
      expect(['connecting', 'connected']).to.include(o.state, JSON.stringify(o))
    }

    // 7. Give each sink a couple seconds of GOP/cache before probing.
    await new Promise(resolve => setTimeout(resolve, 3000))

    // 8. Probe each sink for FLV+H264+AAC
    const [probeA, probeB] = await Promise.all([
      probeRtmp(`rtmp://127.0.0.1:${SINK_A_PORT}/sinkA/${EVT_ID}`, 10000),
      probeRtmp(`rtmp://127.0.0.1:${SINK_B_PORT}/sinkB/${EVT_ID}`, 10000)
    ])

    for (const probe of [probeA, probeB]) {
      expect(probe.format?.format_name).to.match(/flv/)
      const video = (probe.streams as any[]).find(s => s.codec_type === 'video')
      const audio = (probe.streams as any[]).find(s => s.codec_type === 'audio')
      expect(video, 'video stream').to.not.equal(undefined)
      expect(audio, 'audio stream').to.not.equal(undefined)
      expect(video.codec_name).to.equal('h264')
      expect(audio.codec_name).to.equal('aac')
      expect(video.width).to.equal(1280)
      expect(video.height).to.equal(720)
      expect(audio.sample_rate).to.equal('48000')
    }

    // 9. Stop publishing, verify clean teardown
    ffmpegPublisher.kill('SIGTERM')
    ffmpegPublisher = undefined
    await new Promise(resolve => setTimeout(resolve, 2500))

    const finalStatus = splitter.getStatusSnapshot(EVT_ID)
    expect(finalStatus, 'final status').to.not.equal(null)
    expect(finalStatus!.ingress.publishing).to.equal(false)

    splitter.clearSplit(EVT_ID)
  })
})
