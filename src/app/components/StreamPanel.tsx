import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import type {
  GameLiveStreams,
  LiveStream,
  TeamStationClient
} from '../../common/api'
import { copyToClipboard } from '../platform/clipboard'
import { usePublishingReport } from '../player/useVideoListRefresh'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'
import { Card } from './Card'
import { SectionHeader } from './SectionHeader'
import {
  asksTwice,
  runStreamAction,
  type StreamAction,
  streamActionsFor
} from './streamActions'
import { TextField } from './TextField'

/** How long a camera name may be, counted after trimming. */
const CAMERA_NAME_MAX = 80

/** The split the angle strip uses. A name that contains it would be cut. */
const CAMERA_NAME_SEPARATOR = ' — '

/** The name a create sends, or nothing when the field cannot be used. */
function cameraNameToSend(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (trimmed === '') return undefined
  if (trimmed.length > CAMERA_NAME_MAX) return undefined
  if (trimmed.includes(CAMERA_NAME_SEPARATOR)) return undefined
  return trimmed
}

export interface StreamPanelProps {
  client: TeamStationClient
  gameId: string
  /** The videos this game's cameras are publishing to, each time that changes. */
  onPublishing?: (videoIds: string[]) => void
}

/**
 * The cameras pointed at this game.
 *
 * Only the people who run the team ever see this at all: the server answers
 * `404` to everybody else, so an ordinary viewer gets nothing rather than a
 * greyed-out panel telling them a thing exists that they may not have.
 *
 * Of what they see, **their own cameras are whole** — the URL with the key in
 * it, ready to paste — and everybody else's are named: whose it is, what it is
 * called, what it is doing, and a way to stop it. A key publishes video as the
 * person it was issued to, so it is theirs and not the team's; knowing who is
 * streaming is a different thing from being able to stream as them.
 *
 * A person may have up to four cameras active on one game, which is four
 * angles a viewer can switch between while it is being played, and a game may
 * have six.
 */
export function StreamPanel(
  props: StreamPanelProps
): React.ReactElement | null {
  const { client, gameId } = props
  const theme = useTheme()
  const styles = getStyles(theme)

  const [streams, setStreams] = useState<GameLiveStreams | undefined>(undefined)
  /** The URLs revealed this session, by camera. Never kept anywhere else. */
  const [urls, setUrls] = useState<Record<string, string>>({})
  const heldUrls = useRef<Record<string, string>>({})
  const asked = useRef(new Set<string>())
  const gameIdRef = useRef(gameId)
  gameIdRef.current = gameId
  const remember = useCallback((id: string, url: string): void => {
    if (heldUrls.current[id] === url) return
    heldUrls.current = { ...heldUrls.current, [id]: url }
    setUrls(heldUrls.current)
  }, [])
  const [allowed, setAllowed] = useState(true)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  /**
   * Which of the two jobs last wrote `error`.
   *
   * A reveal finishing must not wipe the message from rotate, end, remove, or
   * delete: those share this one string, and a reveal that succeeds has not
   * fixed the action that failed.
   */
  const errorFrom = useRef<'action' | 'reveal' | undefined>(undefined)
  /**
   * Which destructive button is waiting to be pressed again, by camera.
   *
   * Both of them take a game off the air while it is being played: ending a
   * stream closes its window, and a new key stops the encoder holding the old
   * one. A mis-tap on a phone in a dugout costs the rest of the game, so while
   * video is arriving they ask twice. With nothing streaming there is nothing
   * to lose, and they act at once.
   */
  const [armed, setArmed] = useState<string | undefined>(undefined)
  const [cameraName, setCameraName] = useState('')
  // A different game starts empty. Doing this while rendering, rather than in
  // an effect, drops the previous cameras before any reveal can run.
  const [seenGame, setSeenGame] = useState(gameId)
  if (seenGame !== gameId) {
    setSeenGame(gameId)
    setStreams(undefined)
    setUrls({})
    setError(undefined)
    setAllowed(true)
    heldUrls.current = {}
    asked.current = new Set()
    errorFrom.current = undefined
  }

  const reload = useCallback(async (): Promise<void> => {
    const forGame = gameId
    const next = await client.liveStreams(forGame)
    if (gameIdRef.current !== forGame) return
    setStreams(next)
  }, [client, gameId])

  const run = useCallback(
    // `undefined` for the actions that answer with something else, or with
    // nothing: removing a camera and deleting a recording both end with a
    // reload and have no key to remember.
    async (work: () => Promise<LiveStream | undefined>): Promise<void> => {
      const forGame = gameId
      setBusy(true)
      setError(undefined)
      errorFrom.current = undefined
      try {
        const next = await work()
        if (gameIdRef.current !== forGame) return
        const url = next?.url
        if (url != null && next != null) remember(next.id, url)
        await reload()
      } catch (caught: unknown) {
        if (gameIdRef.current !== forGame) return
        errorFrom.current = 'action'
        setError(caught instanceof Error ? caught.message : 'That did not work')
      } finally {
        setBusy(false)
      }
    },
    [gameId, reload, remember]
  )

  useEffect(() => {
    let cancelled = false
    client
      .liveStreams(gameId)
      .then(found => {
        if (!cancelled && found.gameId === gameId) setStreams(found)
      })
      .catch(() => {
        // A 404 here is the ordinary answer for somebody who does not run this
        // team, and the panel simply is not drawn.
        if (!cancelled && gameIdRef.current === gameId) setAllowed(false)
      })
    return () => {
      cancelled = true
    }
  }, [client, gameId])

  // The list omits the address. Ask for each of ours that we do not already
  // hold, together, and leave anybody else's camera unnamed by a key.
  useEffect(() => {
    if (streams?.gameId !== gameId) return
    const askedIds = asked.current
    for (const stream of streams.mine) {
      if (stream.url != null) remember(stream.id, stream.url)
    }
    const pending = streams.mine.filter(
      stream =>
        stream.url == null &&
        heldUrls.current[stream.id] == null &&
        !askedIds.has(stream.id)
    )
    if (pending.length === 0) return
    for (const stream of pending) askedIds.add(stream.id)
    let cancelled = false
    // One camera's failure must not hide an address that did come back.
    Promise.allSettled(
      pending.map(
        async stream => await runStreamAction(client, gameId, stream, 'reveal')
      )
    )
      .then(results => {
        if (cancelled || gameIdRef.current !== gameId) return
        let failure: unknown
        for (const result of results) {
          if (result.status === 'fulfilled') {
            const answered = result.value
            if (answered?.url != null) remember(answered.id, answered.url)
          } else {
            failure ??= result.reason
          }
        }
        // An action's failure is about that action. A reveal that finishes
        // afterwards has not resolved it, so it leaves the message alone.
        if (errorFrom.current === 'action') return
        if (failure == null) {
          if (errorFrom.current === 'reveal') {
            errorFrom.current = undefined
            setError(undefined)
          }
          return
        }
        errorFrom.current = 'reveal'
        setError(
          failure instanceof Error ? failure.message : 'That did not work'
        )
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      for (const stream of pending) {
        if (heldUrls.current[stream.id] == null) askedIds.delete(stream.id)
      }
    }
  }, [client, gameId, remember, streams])

  usePublishingReport(streams, props.onPublishing)

  const all = [...(streams?.mine ?? []), ...(streams?.others ?? [])]
  const anyPublishing = all.some(row => row.state === 'publishing')
  const anyWaiting = all.some(row => row.state === 'idle')
  // A key with no closing time never shuts on its own, so a screen left open
  // on one goes on asking rather than deciding nothing can change.
  const allClosed =
    all.length > 0 &&
    all.every(
      row => row.closesAt != null && Date.parse(row.closesAt) < Date.now()
    )

  /**
   * Three seconds while video is arriving, fifteen while one is only waiting,
   * and not at all once every window has shut and nothing can change. A game
   * screen left open on a clubhouse television should not ask a thousand
   * questions an hour.
   */
  useEffect(() => {
    if (!anyPublishing && !anyWaiting) return
    if (allClosed && !anyPublishing) return
    let cancelled = false
    const timer = setInterval(
      () => {
        client
          .liveStreams(gameId)
          .then(next => {
            if (!cancelled && next.gameId === gameId) setStreams(next)
          })
          .catch(() => undefined)
      },
      anyPublishing ? 3000 : 15000
    )
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [client, gameId, anyPublishing, anyWaiting, allClosed])

  useEffect(() => {
    if (copied == null) return
    const timer = setTimeout(() => {
      setCopied(undefined)
    }, 2000)
    return () => {
      clearTimeout(timer)
    }
  }, [copied])

  // An armed button that is not pressed again goes back to being safe, rather
  // than lying in wait for the next person who touches the screen.
  useEffect(() => {
    if (armed == null) return
    const timer = setTimeout(() => {
      setArmed(undefined)
    }, 5000)
    return () => {
      clearTimeout(timer)
    }
  }, [armed])

  if (!allowed) return null

  /**
   * One destructive press: armed first while the game is on the air, and
   * always for deleting a recording (`asksTwice`), then done.
   */
  const pressOnce = (action: StreamAction, stream: LiveStream): void => {
    const arming = `${action}:${stream.id}`
    if (asksTwice(action, stream) && armed !== arming) {
      setArmed(arming)
      return
    }
    setArmed(undefined)
    run(
      async () => await runStreamAction(client, gameId, stream, action)
    ).catch(() => undefined)
  }

  return (
    <View style={styles.section}>
      <SectionHeader title="Stream to this game" />

      {streams == null && <Text style={styles.muted}>Loading…</Text>}

      {streams?.mine.length === 0 && (
        <Card>
          <Text style={styles.muted}>
            Give yourself a stream URL, then paste it into streaming software or
            pick the game in TS Director.
          </Text>
        </Card>
      )}

      {streams?.mine.map(stream => (
        <Card key={stream.id} style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.state}>{stream.label}</Text>
            <Text style={styles.stateNote}>{whatItIsDoing(stream)}</Text>
          </View>

          {stream.status != null && (
            <View style={styles.legs}>
              <Text style={styles.leg}>
                {stream.status.ingress.receivingPackets
                  ? `Receiving ${rate(stream.status.ingress.bytesPerSecond)}`
                  : stream.status.ingress.publishing
                    ? 'Connected, but no video is arriving'
                    : 'Nothing is streaming to this yet'}
              </Text>
              {stream.status.outputs.map(output => (
                <Text key={output.label} style={styles.leg}>
                  {output.kind === 'hls' ? 'TeamStation' : 'Relay'}
                  {' · '}
                  {output.state === 'connected'
                    ? output.recordedSec == null
                      ? 'connected'
                      : // One leg records the game; the other sends it on.
                        `${clock(output.recordedSec)} ${
                          output.kind === 'hls' ? 'recorded' : 'sent'
                        }`
                    : output.state}
                  {output.restartCount > 0
                    ? ` · reconnected ${output.restartCount}×`
                    : ''}
                  {output.lastError == null ? '' : ` · ${output.lastError}`}
                </Text>
              ))}
            </View>
          )}

          {urls[stream.id] != null && (
            <Pressable
              style={styles.urlBox}
              accessibilityRole="button"
              accessibilityLabel={`Copy the URL for ${stream.label}`}
              onPress={() => {
                const held = urls[stream.id]
                if (held == null) return
                copyToClipboard(held)
                setCopied(stream.id)
              }}
            >
              <Text style={styles.url} selectable numberOfLines={2}>
                {urls[stream.id]}
              </Text>
              <Text style={styles.hint}>
                {copied === stream.id ? 'Copied' : 'Tap to copy'}
              </Text>
            </Pressable>
          )}

          {urls[stream.id] != null && (
            // Worth saying once, where somebody is about to paste it: most
            // streaming software asks for a server and a key in two boxes, and
            // the whole address goes in the first one. The ingest takes it
            // either way round.
            <Text style={styles.note}>
              The whole address goes in your software’s server box. If it asks
              for a stream key as well, leave that empty.
            </Text>
          )}

          <View style={styles.actions}>
            <Button
              label={
                armed === `rotate:${stream.id}`
                  ? 'Tap again: this cuts it off'
                  : 'New key'
              }
              kind="secondary"
              style={styles.action}
              disabled={busy}
              onPress={() => {
                pressOnce('rotate', stream)
              }}
            />
            {offers(stream, true, 'end') && (
              <Button
                label={
                  armed === `end:${stream.id}`
                    ? 'Tap again to end it'
                    : 'End stream'
                }
                kind="secondary"
                style={styles.action}
                disabled={busy}
                onPress={() => {
                  pressOnce('end', stream)
                }}
              />
            )}
          </View>

          {/*
            The recording this camera made, when it made one. A stream started
            to check that a URL works leaves a recording of a car park, and the
            person who made it is the right person to be able to throw it away.
          */}
          {offers(stream, true, 'deleteVideo') && (
            <Button
              label={
                armed === `deleteVideo:${stream.id}`
                  ? 'Tap again to delete it'
                  : 'Delete the recording'
              }
              kind="text"
              textColor={theme.dangerColor}
              style={styles.textAction}
              disabled={busy}
              onPress={() => {
                // Always armed, whatever the camera is doing: this one cannot
                // be undone, and the row above it can.
                pressOnce('deleteVideo', stream)
              }}
            />
          )}

          {/*
            Removing a camera is not ending one. Ending it stops it; this
            takes it off the game and gives its number back, which is what
            somebody who added a fourth by mistake actually wants.
          */}
          {offers(stream, true, 'remove') && (
            <Button
              label="Remove camera"
              kind="text"
              style={styles.textAction}
              disabled={busy}
              onPress={() => {
                pressOnce('remove', stream)
              }}
            />
          )}

          {stream.lastError != null && (
            <Text style={styles.warning}>{stream.lastError}</Text>
          )}
        </Card>
      ))}

      {streams != null && streams.canAdd > 0 && (
        <>
          <TextField
            label="Camera name"
            value={cameraName}
            onChangeText={setCameraName}
            placeholder="First base"
          />
          <Button
            label={
              streams.mine.length === 0 ? 'Create a stream URL' : 'Add a camera'
            }
            kind="secondary"
            disabled={busy || cameraNameToSend(cameraName) == null}
            onPress={() => {
              const label = cameraNameToSend(cameraName)
              if (label == null) return
              run(async () => {
                const added = await client.addLiveStream(gameId, label)
                setCameraName('')
                return added
              }).catch(() => undefined)
            }}
          />
        </>
      )}

      {streams?.gameCanAdd === 0 && (
        <Text style={styles.muted}>
          This game already has 6 cameras. End one to add another.
        </Text>
      )}
      {streams != null &&
        streams.gameCanAdd > 0 &&
        streams.mine.length > 0 &&
        streams.canAdd === 0 && (
          <Text style={styles.muted}>
            That is all {streams.maxCameras} of your cameras on this game. End
            one to add another.
          </Text>
        )}

      {/*
        Who else is streaming this game. Named, never revealed: what they are
        holding publishes video as them.
      */}
      {streams != null && streams.others.length > 0 && (
        <>
          <SectionHeader title="Also streaming" />
          {streams.others.map(stream => (
            <Card key={stream.id} style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.state}>
                  {stream.ownerName} · {stream.label}
                </Text>
                <Text style={styles.stateNote}>{whatItIsDoing(stream)}</Text>
              </View>
              {offers(stream, false, 'end') && (
                <Button
                  label={
                    armed === `end:${stream.id}`
                      ? 'Tap again to end it'
                      : 'End this stream'
                  }
                  kind="secondary"
                  disabled={busy}
                  onPress={() => {
                    pressOnce('end', stream)
                  }}
                />
              )}
            </Card>
          ))}
        </>
      )}

      {error != null && <Text style={styles.warning}>{error}</Text>}
    </View>
  )
}

/** Whether a camera offers an action, by the rules both panels share. */
function offers(
  stream: LiveStream,
  mine: boolean,
  action: StreamAction
): boolean {
  return streamActionsFor(stream, mine).includes(action)
}

/** The four things a camera can be, in a word. */
function whatItIsDoing(stream: LiveStream): string {
  if (stream.state === 'publishing') return 'Live now'
  if (stream.state === 'ended') return 'Finished'
  if (stream.closesAt == null) return 'Ready'
  return Date.parse(stream.closesAt) < Date.now() ? 'Closed' : 'Ready'
}

/** `1:04:12`, or `4:12` for anything under an hour. */
function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const rest = whole % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(rest)}`
    : `${minutes}:${pad(rest)}`
}

/** `3.4 Mbit/s`, which is the unit an encoder is set in. */
function rate(bytesPerSecond: number): string {
  const mbit = (bytesPerSecond * 8) / 1_000_000
  return mbit >= 1
    ? `${mbit.toFixed(1)} Mbit/s`
    : `${Math.round(mbit * 1000)} kbit/s`
}

const getStyles = cacheStyles((theme: Theme) => ({
  section: {
    gap: theme.rem(theme.spaceMdRem)
  },
  card: {
    gap: theme.rem(theme.spaceMdRem)
  },
  legs: {
    gap: theme.rem(0.125)
  },
  leg: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  state: {
    flex: 1,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  stateNote: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  urlBox: {
    backgroundColor: theme.inactiveBackgroundColor,
    borderRadius: theme.rem(theme.radiusRem),
    padding: theme.rem(theme.cardContentInsetRem),
    gap: theme.rem(0.25)
  },
  url: {
    // Monospace: this is a string somebody checks character by character when
    // it does not work.
    fontFamily: 'monospace',
    fontSize: theme.rem(0.8125),
    color: theme.primaryTextColor
  },
  hint: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.75),
    color: theme.secondaryTextColor
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.rem(theme.spaceSmRem)
  },
  actions: {
    flexDirection: 'row',
    gap: theme.rem(1)
  },
  action: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  textAction: {
    alignSelf: 'flex-start',
    paddingHorizontal: 0
  },
  note: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor,
    marginTop: theme.rem(theme.spaceXsRem)
  },
  muted: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.secondaryTextColor
  },
  warning: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
