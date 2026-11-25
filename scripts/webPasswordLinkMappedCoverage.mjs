import { readFileSync } from 'node:fs'

import { transform } from 'sucrase'

import { mappedV8LineCounts } from './changed-line-coverage.cjs'

// Different coverage runs can observe different modules. The combined gate
// checks for missing lines after merging the real counters from every runtime.
export function measuredMappedLines(
  map,
  source,
  scripts,
  wanted,
  options = {}
) {
  return mappedV8LineCounts(source, map, scripts, wanted, {
    ...options,
    partial: true
  })
}

// Reproduce the installed sucrase/register hook, including its inline map.
// V8 offsets refer to this exact JavaScript, not the original TypeScript.
export function nodeCoverageSource(path, recorded) {
  const original = readFileSync(path, 'utf8')
  const compiled = transform(original, {
    transforms: path.endsWith('.tsx')
      ? ['imports', 'typescript', 'jsx']
      : ['imports', 'typescript'],
    ...JSON.parse(process.env.SUCRASE_OPTIONS ?? '{}'),
    sourceMapOptions: { compiledFilename: path },
    filePath: path
  })
  const encoded = Buffer.from(JSON.stringify(compiled.sourceMap)).toString(
    'base64'
  )
  const source =
    compiled.code +
    '\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,' +
    encoded
  if (
    compiled.sourceMap.mappings !== recorded.data.mappings ||
    JSON.stringify(source.split('\n').map(line => line.length)) !==
      JSON.stringify(recorded.lineLengths)
  )
    throw Error(
      'Recorded Node coverage differs from the compiled source: ' + path
    )
  return source
}
