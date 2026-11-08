const { readFileSync } = require('node:fs')
const { dirname, relative, resolve } = require('node:path')
const { createCoverageMap } = require('istanbul-lib-coverage')
const { verifyCoverageSource } = require('./coverage-provenance.cjs')

/** Merge measured counters, rejecting absent or stale browser evidence. */
function scoringCombinedCoverage(unit, manifestPath, cwd, base) {
  if (!manifestPath)
    throw new Error(
      'Supply TS_SCORING_BROWSER_COVERAGE from the scoring browser journey'
    )
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  verifyCoverageSource(manifest.source, cwd, base)
  if (!Array.isArray(manifest.files) || manifest.files.length < 2)
    throw new Error('Missing counters from both scoring browsers')
  const combined = createCoverageMap(unit)
  for (const file of manifest.files) {
    const measured = JSON.parse(readFileSync(file, 'utf8'))
    if (
      !Object.keys(measured).some(path =>
        path.endsWith('/src/app/scoring/ScoringScreen.tsx')
      )
    )
      throw new Error('Missing mapped scoring screen browser counters')
    combined.merge(measured)
  }
  return combined.toJSON()
}
module.exports = { scoringCombinedCoverage }

function verifyScoringBundle(mapPath, cwd) {
  const map = JSON.parse(readFileSync(mapPath, 'utf8'))
  let sources = 0
  for (const [index, source] of map.sources.entries()) {
    const file = resolve(dirname(mapPath), map.sourceRoot ?? '', source)
    if (!relative(cwd, file).startsWith('src/')) continue
    if (readFileSync(file, 'utf8') !== map.sourcesContent?.[index])
      throw new Error('Stale scoring test bundle: ' + relative(cwd, file))
    sources++
  }
  if (sources === 0) throw new Error('Missing mapped scoring test sources')
}
module.exports.verifyScoringBundle = verifyScoringBundle
