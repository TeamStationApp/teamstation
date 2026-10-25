/**
 * Every write to a game's scoreboard, in one atomic step.
 *
 *   KEYS[1]  the game's hash, `<prefix>:scoreboard:<gameId>`
 *   ARGV[1]  the field: `game`, `watcher` or `overrides`
 *   ARGV[2]  its JSON: a state, or the whole overrides object
 *   ARGV[3]  the mode: `replace`, `merge`, `mergeUncontested`, `reset`, or
 *            `clearGame`
 *   ARGV[4]  now, in milliseconds
 *   ARGV[5]  the game's start, in milliseconds
 *   ARGV[6]  the game write's `sourceVersion`, or empty
 *   ARGV[7]  the pub/sub channel
 *   ARGV[8]  the game id, which the message names
 *
 * It answers `closed` without writing when the scoreboard has closed, and
 * `stale` when a game write is older than the one stored. Otherwise it
 * writes the field, `lastUpdate` and `version`, sets the key's expiry, and
 * publishes and returns the whole hash after the write as one JSON message.
 * `reset` is the dashboard's Reset Game State: it writes the overrides it is
 * given (none) and deletes the `watcher` field in the same step, so the board
 * falls back to the game's own scoring over its record. `clearGame` deletes
 * the `game` field instead of writing it, for a game reset to no plays and
 * no lineups; it answers `closed` and writes nothing when there is none.
 *
 * `version` is `max(stored + 1, now × 1000)`, with a missing key counted as
 * 0, so it never goes backwards: not after the key expires or is evicted, and
 * not after Redis comes back from an older snapshot. It is 16 digits long,
 * and Redis's `cjson` keeps 14 significant digits, so it and every other
 * stamp is written as a decimal string with `string.format('%d', …)`. The
 * stored fields are copied into the message as they are, never re-encoded.
 *
 * It is a TypeScript string rather than a `.lua` file so that `tsc` ships it
 * with the server.
 */
export const WRITE_SCOREBOARD = `
local key = KEYS[1]
local field = ARGV[1]
local json = ARGV[2]
local mode = ARGV[3]
local now = tonumber(ARGV[4])
local startAt = tonumber(ARGV[5])
local sourceVersion = ARGV[6]
local channel = ARGV[7]
local gameId = ARGV[8]

local HOUR = 3600000
local exists = redis.call('EXISTS', key) == 1
if now >= startAt + 72 * HOUR or ((not exists) and now >= startAt + 2 * HOUR) then
  return 'closed'
end

local stored = redis.call('HGET', key, field)
local previous = nil
if stored then previous = cjson.decode(stored) end

if mode == 'clearGame' and previous == nil then
  return 'closed'
end

if field == 'game' and previous ~= nil and previous.sourceVersion ~= nil
  and sourceVersion ~= '' and tonumber(previous.sourceVersion) > tonumber(sourceVersion) then
  return 'stale'
end

local value = json
if mode == 'clearGame' then
  value = nil
elseif field ~= 'overrides' then
  local state = cjson.decode(json)
  if mode ~= 'replace' then
    local merged = {}
    if previous ~= nil and type(previous.state) == 'table' then
      for name, entry in pairs(previous.state) do merged[name] = entry end
    end
    for name, entry in pairs(state) do merged[name] = entry end
    state = merged
  end
  local receivedAt = string.format('%d', now)
  if mode == 'mergeUncontested' then
    receivedAt = '0'
    if previous ~= nil and previous.receivedAt ~= nil then
      receivedAt = previous.receivedAt
    end
  end
  local entry = { state = state, receivedAt = receivedAt }
  if field == 'game' and sourceVersion ~= '' then
    entry.sourceVersion = sourceVersion
  end
  value = cjson.encode(entry)
end

local storedVersion = tonumber(redis.call('HGET', key, 'version') or '0') or 0
local version = math.max(storedVersion + 1, now * 1000)
local versionText = string.format('%d', version)
if value == nil then
  redis.call('HDEL', key, field)
  redis.call('HSET', key, 'lastUpdate', string.format('%d', now),
    'version', versionText)
else
  redis.call('HSET', key, field, value, 'lastUpdate', string.format('%d', now),
    'version', versionText)
end
if mode == 'reset' then redis.call('HDEL', key, 'watcher') end
local expiry = math.min(math.max(now, startAt) + 2 * HOUR, startAt + 72 * HOUR)
redis.call('PEXPIREAT', key, string.format('%d', expiry))

local function raw(name)
  local found = redis.call('HGET', key, name)
  if found then return found end
  return 'null'
end
local message = '{"gameId":' .. cjson.encode(gameId) ..
  ',"version":"' .. versionText ..
  '","field":"' .. field ..
  '","game":' .. raw('game') ..
  ',"watcher":' .. raw('watcher') ..
  ',"overrides":' .. raw('overrides') .. '}'
redis.call('PUBLISH', channel, message)
return message
`
