import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { decodedMappings, TraceMap } from '@jridgewell/trace-mapping'
import libCoverage from 'istanbul-lib-coverage'

import lines from './changed-line-coverage.cjs'

// The source decides which changes need instrumentation. Istanbul's location
// spans decide which lines each real counter measures, just as in the gate.
export function requiredLines(file, source, changed = []) {
  const executable = lines.executableLines(file, source)
  return new Set([...changed].filter(line => executable.has(line)))
}

export function requireCounters(report, file, required) {
  const entry = report[resolve(file)]
  if (!entry) throw new Error('No measured coverage for ' + file)
  for (const id of Object.keys(entry.statementMap)) {
    if (!Number.isFinite(entry.s[id]) || entry.s[id] < 0)
      throw new Error(
        `Invalid statement counter for ${file}:${entry.statementMap[id].start.line}`
      )
  }
  const counts = lines.istanbulCounts(entry)
  for (const line of required)
    if (!(line in counts))
      throw new Error(`Missing measured counter for ${file}:${line}`)
}

// A release optimizer may fold multiple source lines together. Read the
// original positions independently from the exact map the build published.
export function mappedSourceLines(data, pathFor) {
  const paths = data.sources.map(pathFor)
  const files = new Map(paths.filter(Boolean).map(file => [file, new Set()]))
  for (const line of decodedMappings(new TraceMap(data))) {
    for (const segment of line) {
      const file = paths[segment[1]]
      if (file) files.get(file).add(segment[2] + 1)
    }
  }
  return files
}

// tsc mirrors src/ under lib/. A measured compiled module must carry the
// original TypeScript mapping even when another process also loaded its source.
export function compiledCoverageSource(name, map, pathFor) {
  const compiled = /\/lib\/(common|server)\/(.+)\.js$/.exec(name)
  if (!compiled) return
  const file = pathFor(`src/${compiled[1]}/${compiled[2]}.ts`)
  if (!file) return
  const data = map?.data
  const sourceIndex = data?.sources?.findIndex(url => pathFor(url) === file)
  if (
    data?.version !== 3 ||
    !(sourceIndex >= 0) ||
    !map.lineLengths?.length ||
    !decodedMappings(new TraceMap(data)).some(line =>
      line.some(segment => segment[1] === sourceIndex)
    )
  )
    throw new Error('Missing usable compiled source map for ' + file)
  if (data.sourcesContent?.[sourceIndex] !== readFileSync(file, 'utf8'))
    throw new Error('Missing or stale compiled source content for ' + file)
  return file
}

// Both the JSON object key and Istanbul's embedded path belong to the
// checkout that collected the counters. Merge them under this tree's path.
export function localCoverageMap(report, pathFor) {
  const local = libCoverage.createCoverageMap({})
  for (const [key, value] of Object.entries(report)) {
    const file = pathFor(key)
    if (file) local.addFileCoverage({ ...value, path: resolve(file) })
  }
  return local
}
