import React, { useCallback, useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import type {
  GameLiveStreams,
  GameStationClient,
  LiveStream
} from '../../common/api'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'
import { Card } from './Card'
import { SectionHeader } from './SectionHeader'

export interface StreamPanelProps {
  client: GameStationClient
  gameId: string
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
 * A person may point up to four cameras at one game, which is four angles a
 * viewer can switch between while it is being played.
 */
export function StreamPanel(
  props: StreamPanelProps
): React.ReactElement | null {
  const { client, gameId } = props
  const styles = getStyles(useTheme())

  const [streams, setStreams] = useState<GameLiveStreams | undefined>(undefined)
  /** The URLs revealed this session, by camera. Never kept anywhere else. */
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [allowed, setAllowed] = useState(true)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
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

  const reload = useCallback(async (): Promise<void> => {
    setStreams(await client.liveStreams(gameId))
  }, [client, gameId])

  const run = useCallback(
    // `undefined` for the actions that answer with something else, or with
    // nothing: removing a camera and deleting a recording both end with a
    // reload and have no key to remember.
    async (work: () => Promise<LiveStream | undefined>): Promise<void> => {
      setBusy(true)
      setError(undefined)
      try {
        const next = await work()
        const url = next?.url
        if (url != null && next != null) {
          setUrls(held => ({ ...held, [next.id]: url }))
        }
        await reload()
      } catch (caught: unknown) {
        setError(caught instanceof Error ? caught.message : 'That did not work')
      } finally {
        setBusy(false)
      }
    },
    [reload]
  )

  useEffect(() => {
    let cancelled = false
    client
      .liveStreams(gameId)
      .then(found => {
        if (!cancelled) setStreams(found)
      })
      .catch(() => {
        // A 404 here is the ordinary answer for somebody who does not run this
        // team, and the panel simply is not drawn.
        if (!cancelled) setAllowed(false)
      })
    return () => {
      cancelled = true
    }
  }, [client, gameId])

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
            if (!cancelled) setStreams(next)
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

  /** One destructive press, armed while the game is on the air. */
  const pressOnce = (
    kind: 'rotate' | 'end' | 'remove' | 'deleteVideo',
    stream: LiveStream,
    act: () => void
  ): void => {
    const arming = `${kind}:${stream.id}`
    if (stream.state === 'publishing' && armed !== arming) {
      setArmed(arming)
      return
    }
    setArmed(undefined)
    act()
  }

  return (
    <View style={styles.section}>
      <SectionHeader title="Stream to this game" />

      {streams == null && <Text style={styles.muted}>Loading…</Text>}

      {streams?.mine.length === 0 && (
        <Card>
          <Text style={styles.muted}>
            Give yourself a stream URL, then paste it into streaming software or
            pick the game in GS Director.
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
                  {output.kind === 'hls' ? 'GameStation' : 'Relay'}
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

          <Pressable
            style={styles.urlBox}
            accessibilityRole="button"
            accessibilityLabel={
              urls[stream.id] == null
                ? `Show the URL for ${stream.label}`
                : `Copy the URL for ${stream.label}`
            }
            onPress={() => {
              const held = urls[stream.id]
              if (held == null) {
                run(
                  async () => await client.revealLiveStream(gameId, stream.id)
                ).catch(() => undefined)
                return
              }
              copyToClipboard(held)
              setCopied(stream.id)
            }}
          >
            <Text style={styles.url} selectable numberOfLines={2}>
              {urls[stream.id] ?? `••••••••  ${stream.keyPrefix}…`}
            </Text>
            <Text style={styles.hint}>
              {urls[stream.id] == null
                ? 'Tap to show'
                : copied === stream.id
                  ? 'Copied'
                  : 'Tap to copy'}
            </Text>
          </Pressable>

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
                pressOnce('rotate', stream, () => {
                  run(
                    async () => await client.rotateLiveStream(gameId, stream.id)
                  ).catch(() => undefined)
                })
              }}
            />
            {stream.state !== 'ended' && (
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
                  pressOnce('end', stream, () => {
                    run(
                      async () => await client.endLiveStream(gameId, stream.id)
                    ).catch(() => undefined)
                  })
                }}
              />
            )}
            {/*
              Removing a camera is not ending one. Ending it stops it; this
              takes it off the game and gives its number back, which is what
              somebody who added a fourth by mistake actually wants.
            */}
            {stream.state !== 'publishing' && (
              <Button
                label="Remove camera"
                kind="text"
                style={styles.action}
                disabled={busy}
                onPress={() => {
                  pressOnce('remove', stream, () => {
                    run(async () => {
                      await client.removeLiveStream(gameId, stream.id)
                      return undefined
                    }).catch(() => undefined)
                  })
                }}
              />
            )}
          </View>

          {/*
            The recording this camera made, when it made one. A stream started
            to check that a URL works leaves a recording of a car park, and the
            person who made it is the right person to be able to throw it away.
          */}
          {stream.videoId != null && stream.state !== 'publishing' && (
            <Button
              label={
                armed === `deleteVideo:${stream.id}`
                  ? 'Tap again to delete it'
                  : 'Delete the recording'
              }
              kind="text"
              disabled={busy}
              onPress={() => {
                // Always armed, whatever the camera is doing: this one cannot
                // be undone, and the row above it can.
                const arming = `deleteVideo:${stream.id}`
                if (armed !== arming) {
                  setArmed(arming)
                  return
                }
                setArmed(undefined)
                const videoId = stream.videoId
                if (videoId == null) return
                run(async () => {
                  await client.deleteVideo(videoId)
                  return undefined
                }).catch(() => undefined)
              }}
            />
          )}

          {stream.lastError != null && (
            <Text style={styles.warning}>{stream.lastError}</Text>
          )}
        </Card>
      ))}

      {streams != null && streams.canAdd > 0 && (
        <Button
          label={
            streams.mine.length === 0 ? 'Create a stream URL' : 'Add a camera'
          }
          kind="secondary"
          disabled={busy}
          onPress={() => {
            run(async () => await client.addLiveStream(gameId)).catch(
              () => undefined
            )
          }}
        />
      )}

      {streams != null && streams.mine.length > 0 && streams.canAdd === 0 && (
        <Text style={styles.muted}>
          That is all {streams.maxCameras} of your cameras on this game. End one
          to add another.
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
              {stream.state !== 'ended' && (
                <Button
                  label={
                    armed === `end:${stream.id}`
                      ? 'Tap again to end it'
                      : 'End this stream'
                  }
                  kind="secondary"
                  disabled={busy}
                  onPress={() => {
                    pressOnce('end', stream, () => {
                      run(
                        async () =>
                          await client.endLiveStream(gameId, stream.id)
                      ).catch(() => undefined)
                    })
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

/**
 * The clipboard, where this app runs.
 *
 * Web only for now, like the rest of the app: `navigator.clipboard` is what a
 * browser has, and a native build would put `Clipboard` from React Native
 * behind this same call.
 */
function copyToClipboard(text: string): void {
  const clipboard = (globalThis as { navigator?: Navigator }).navigator
    ?.clipboard
  if (clipboard == null) return
  clipboard.writeText(text).catch(() => undefined)
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
    padding: theme.rem(theme.spaceSmRem),
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
    gap: theme.rem(theme.spaceSmRem)
  },
  action: {
    flex: 1
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
