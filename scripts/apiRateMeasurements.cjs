// Test-process preload. Capture only requests tagged by the workload driver.
// Write one numeric sample per response, including work on concurrent requests.
const { AsyncLocalStorage } = require('node:async_hooks')
const { appendFileSync } = require('node:fs')
const { Server } = require('node:http')
const { Client, Pool } = require('pg')
const active = new AsyncLocalStorage()
const file = process.env.RATE_WORKLOAD_SAMPLES
const emit = Server.prototype.emit
Server.prototype.emit = function (event, ...args) {
  if (event !== 'request' || !file) return emit.call(this, event, ...args)
  const [req, res] = args
  const journey = req.headers['x-fixture-journey']
  if (
    ![
      'launch',
      'packages',
      'reconnect',
      'guest4',
      'guest6',
      'guest8',
      'member',
      'schedule1',
      'schedule10',
      'schedule50',
      'schedule200',
      'retry'
    ].includes(journey)
  )
    return emit.call(this, event, ...args)
  const sample = {
    journey,
    sql: 0,
    sqlMs: 0,
    poolMs: 0,
    gateMs: [],
    refusals: 0,
    ms: 0,
    status: 0
  }
  const start = performance.now()
  res.once('finish', () => {
    sample.ms = performance.now() - start
    sample.status = res.statusCode
    appendFileSync(file, JSON.stringify(sample) + '\n')
  })
  return active.run(sample, () => emit.call(this, event, ...args))
}
function measure(prototype, method, key) {
  const original = prototype[method]
  prototype[method] = function (...args) {
    const sample = active.getStore()
    if (!sample) return original.apply(this, args)
    if (method === 'query') sample.sql++
    const start = performance.now()
    const done = () => {
      sample[key] += performance.now() - start
    }
    const last = args.length - 1
    if (typeof args[last] === 'function') {
      const callback = args[last]
      args[last] = function (...values) {
        done()
        return callback.apply(this, values)
      }
    }
    const result = original.apply(this, args)
    if (result instanceof Promise) result.then(done, done)
    return result
  }
}
measure(Client.prototype, 'query', 'sqlMs')
measure(Pool.prototype, 'connect', 'poolMs')

// The same elapsed store time and first refusal that feed operational summaries.
// Keep request correlation in the test process, including in observation mode.
const path = require('node:path')
const metrics = require(
  path.join(
    process.env.RATE_WORKLOAD_ROOT,
    'src/server/observability/apiRateMetrics'
  )
)
const rateMetrics = metrics.rateMetrics
metrics.rateMetrics = function (...args) {
  const collector = rateMetrics(...args)
  const record = collector.record
  collector.record = function (buckets, tier, transport, decision, ms) {
    const sample = active.getStore()
    if (sample) {
      if (decision.backend === 'shared') sample.gateMs.push(ms)
      if (decision.retryAfterSec > 0) ++sample.refusals
    }
    record(buckets, tier, transport, decision, ms)
  }
  return collector
}
