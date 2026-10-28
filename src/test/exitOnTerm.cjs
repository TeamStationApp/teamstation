// Preloaded into a long-running child a test stops (`node -r`): SIGTERM ends
// it through process.exit, which writes its NODE_V8_COVERAGE where a signal's
// default would not.
process.once('SIGTERM', () => {
  process.exit(0)
})
