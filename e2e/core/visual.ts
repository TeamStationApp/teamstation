import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { type GoldenManifest, readGolden, requireStore } from './goldens'
import { HarnessError } from './result'

/** The default share of pixels allowed to differ, and the most any checkpoint may. */
export const DEFAULT_MAX_DIFFERING_PERCENT = 0.1
export const MAX_DIFFERING_PERCENT = 1

export interface GoldenOptions {
  mask?: Array<Record<string, unknown>>
  /** Above the default only with a `reason`. Lint rejects anything above 1%. */
  maxDifferingPercent?: number
  reason?: string
}

export type VisualVerdictName = 'pass' | 'fail' | 'unbaselined'

export interface VisualVerdict {
  verdict: VisualVerdictName
  key: string
  mask: unknown[]
  capturePath?: string
  goldenPath?: string
  sha256?: string
  diffPath?: string
  matchPercentage?: number
  differingPixels?: number
  totalPixels?: number
  detail?: string
}

interface ScreenshotData {
  code?: string
  matchPercentage?: number
  differingPixels?: number
  totalPixels?: number
  diffPath?: string
  capturePath?: string
}

interface CommandError extends Error {
  code?: string
  result?: { data?: ScreenshotData }
}

export interface CompareInputs {
  device: {
    assertScreenshot: (options: Record<string, unknown>) => Promise<{
      data?: ScreenshotData
    }>
  }
  runDir: string
  checkpoint: string
  key: string
  golden: GoldenOptions
  manifest: GoldenManifest
  store: string | undefined
  /** On the web, the indices of the drawn elements a CSS selector matches. */
  drawn?: (css: string) => Promise<number[]>
}

/**
 * The masks as maestro-d takes them. maestro-d masks the one element a
 * selector finds; a CSS mask marked `every` stands for each drawn element
 * it matches, one entry each by its index among the matches, and for none
 * when nothing it matches is drawn. Every other mask goes as it is, and
 * still fails a checkpoint when it matches nothing.
 */
export async function expandMasks(
  mask: ReadonlyArray<Record<string, unknown>>,
  drawn?: (css: string) => Promise<number[]>
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  for (const entry of mask) {
    const { every, ...rest } = entry
    if (every !== true || typeof rest.css !== 'string' || drawn == null) {
      out.push(rest)
      continue
    }
    for (const index of await drawn(rest.css))
      out.push({ ...rest, index: String(index) })
  }
  return out
}

/**
 * Compares against the golden copied into the run directory, so the store stays clean
 * and maestro-d's diff lands beside it. With no golden the frame is still captured,
 * for `golden accept`, and nothing creates a reference.
 */
export async function compareGolden(
  inputs: CompareInputs
): Promise<VisualVerdict> {
  const { device, runDir, checkpoint, key, golden, manifest } = inputs
  const expectedDir = join(runDir, 'goldens')
  mkdirSync(expectedDir, { recursive: true })
  const expected = join(expectedDir, `${checkpoint}.png`)
  const capture = join(runDir, 'captures', `${checkpoint}.png`)
  const mask = await expandMasks(golden.mask ?? [], inputs.drawn)
  const entry = manifest.goldens[key]
  const bytes =
    entry == null
      ? undefined
      : readGolden(requireStore(inputs.store), entry.sha256)
  if (bytes != null) writeFileSync(expected, bytes)

  const base: VisualVerdict = {
    verdict: 'unbaselined',
    key,
    mask,
    capturePath: capture,
    ...(entry == null ? {} : { sha256: entry.sha256 })
  }
  const read = (data: ScreenshotData | undefined): VisualVerdict => ({
    ...base,
    verdict: 'pass',
    ...(bytes == null ? {} : { goldenPath: expected }),
    ...(data?.diffPath == null ? {} : { diffPath: data.diffPath }),
    ...(data?.matchPercentage == null
      ? {}
      : { matchPercentage: data.matchPercentage }),
    ...(data?.differingPixels == null
      ? {}
      : { differingPixels: data.differingPixels }),
    ...(data?.totalPixels == null ? {} : { totalPixels: data.totalPixels })
  })
  try {
    const reply = await device.assertScreenshot({
      path: expected,
      mask,
      requireBaseline: true,
      captureOut: capture,
      thresholdPercentage:
        100 - (golden.maxDifferingPercent ?? DEFAULT_MAX_DIFFERING_PERCENT)
    })
    return read(reply.data)
  } catch (error) {
    const failure = error as CommandError
    if (failure.code !== 'COMMAND_FAILED') {
      throw new HarnessError(`assertScreenshot: ${failure.message}`)
    }
    const data = failure.result?.data
    if (data?.code === 'BASELINE_MISSING') {
      return {
        ...read(data),
        verdict: 'unbaselined',
        detail:
          entry == null
            ? `no golden for ${key}`
            : `golden ${entry.sha256} is in no branch of the store`
      }
    }
    return { ...read(data), verdict: 'fail', detail: failure.message }
  }
}
