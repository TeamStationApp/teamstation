/**
 * The fault controller the existing chat runners call, as
 * `node <this file> <actor> <action> <gateId> [delayMs]` or
 * `node <this file> clear`. Its private settings, which hold the owned
 * relay's control token, are the file `CHAT_RECOVERY_CONTROL_FILE` names.
 */
require('sucrase/register')
const { runRecoveryControl } = require('../src/test/chatRecoveryControl')

runRecoveryControl(
  process.env.CHAT_RECOVERY_CONTROL_FILE,
  process.argv.slice(2)
).catch(() => {
  // Never print the settings or the request: they carry the control token.
  console.error('Recovery fault control refused; inspect the private fixture')
  process.exitCode = 1
})
