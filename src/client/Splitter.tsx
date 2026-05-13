import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { ImageStyle } from 'react-native'
import { Image, Pressable, Text, TextInput, View } from 'react-native'
import { useNavigate, useParams } from 'react-router-dom'

import {
  asSplitStatusMessage,
  type SplitOutboundStatus,
  type SplitStatus,
  WS_RECONNECT_WAIT_MS
} from '../common/types'
import { clientConfig } from './clientConfig'
import { cacheStyles, useTheme } from './ThemeContext'
import type { Theme } from './types'

interface SplitConfigResponse {
  splitterUrl: string
  app: string
}

const emptyStatus = (eventId: string): SplitStatus => ({
  eventId,
  destinations: [],
  ingress: {
    publishing: false,
    receivingPackets: false,
    bytesReceived: 0,
    bytesPerSecond: 0
  },
  outbounds: []
})

const formatBitrate = (bytesPerSecond: number): string => {
  const bps = bytesPerSecond * 8
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(2)} Mbps`
  if (bps >= 1_000) return `${(bps / 1_000).toFixed(1)} Kbps`
  return `${bps} bps`
}

const Splitter: React.FC = () => {
  const { eventId: eventIdParam } = useParams<{ eventId: string }>()
  const navigate = useNavigate()
  const theme = useTheme()
  const styles = getStyles(theme)

  const [eventIdInput, setEventIdInput] = useState(eventIdParam ?? '')
  const [destination1, setDestination1] = useState('')
  const [destination2, setDestination2] = useState('')
  const [splitConfig, setSplitConfig] = useState<SplitConfigResponse | null>(
    null
  )
  const [status, setStatus] = useState<SplitStatus | null>(null)
  const [feedback, setFeedback] = useState<string>('')
  const [isSaving, setIsSaving] = useState(false)
  const [ingressCopied, setIngressCopied] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const shouldReconnectRef = useRef(true)
  // Last destination values we know the server is holding for this
  // event. Used to decide whether it is safe to auto-overwrite the
  // input fields when a remote actor (another browser, the API) updates
  // the splitter config: we only sync when the input still matches the
  // last-known server value, so locally-typed edits are never silently
  // clobbered. Updated on initial GET, on successful save, and from the
  // status WebSocket.
  const serverDest1Ref = useRef<string>('')
  const serverDest2Ref = useRef<string>('')

  // Load splitter config (rtmp host/port) once on mount
  useEffect(() => {
    let cancelled = false
    fetch('/api/v1/split/config')
      .then(async r => await r.json())
      .then((json: SplitConfigResponse) => {
        if (!cancelled) setSplitConfig(json)
      })
      .catch((err: unknown) => {
        console.error('Failed to load split config:', err)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const generateEventId = useCallback((): void => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    let result = ''
    for (let i = 0; i < 12; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    setEventIdInput(result)
  }, [])

  const ingressUrl =
    eventIdParam != null && eventIdParam !== '' && splitConfig != null
      ? `${splitConfig.splitterUrl}/${splitConfig.app}/${eventIdParam}`
      : ''

  // Subscribe to live status when an eventId is present in the URL
  useEffect(() => {
    if (eventIdParam == null || eventIdParam === '') {
      setStatus(null)
      return
    }
    // Reset form + sync state so we don't briefly show another event's
    // destinations while the GET round-trip completes.
    setStatus(emptyStatus(eventIdParam))
    setDestination1('')
    setDestination2('')
    serverDest1Ref.current = ''
    serverDest2Ref.current = ''

    let wsUrl: string
    // @ts-expect-error injected by webpack DefinePlugin in dev mode
    if (window.__WEBPACK_DEV__ === true) {
      wsUrl = `${clientConfig.apiServer}/sockets/api/v1/split/${eventIdParam}`
    } else {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      wsUrl = `${protocol}//${window.location.host}/sockets/api/v1/split/${eventIdParam}`
    }

    shouldReconnectRef.current = true
    const connect = (): void => {
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws
      ws.onmessage = event => {
        try {
          const raw = JSON.parse(event.data)
          const msg = asSplitStatusMessage(raw)
          setStatus(msg.data)
        } catch (error) {
          console.error('Invalid split status message:', error)
        }
      }
      ws.onerror = error => {
        console.error('Split status WebSocket error:', error)
      }
      ws.onclose = () => {
        if (shouldReconnectRef.current) {
          reconnectTimeoutRef.current = setTimeout(() => {
            connect()
          }, WS_RECONNECT_WAIT_MS)
        }
      }
    }
    connect()

    // Also fetch the current snapshot to populate destinations immediately
    fetch(`/api/v1/split/${eventIdParam}`)
      .then(async r => await r.json())
      .then((json: SplitStatus) => {
        setStatus(json)
        const d0 = json.destinations[0] ?? ''
        const d1 = json.destinations[1] ?? ''
        setDestination1(d0)
        setDestination2(d1)
        serverDest1Ref.current = d0
        serverDest2Ref.current = d1
      })
      .catch((err: unknown) => {
        console.error('Failed to load split snapshot:', err)
      })

    return () => {
      shouldReconnectRef.current = false
      if (reconnectTimeoutRef.current != null) {
        clearTimeout(reconnectTimeoutRef.current)
      }
      if (wsRef.current != null) wsRef.current.close()
    }
  }, [eventIdParam])

  // When the live status changes (e.g. another browser saved new
  // destinations, or the API was hit directly), keep the destination
  // input fields in sync IF the user hasn't typed since the last sync.
  // The "hasn't typed" check is implicit: if the input still equals the
  // last server-known value, we treat it as clean and overwrite; if the
  // user has diverged, we leave their unsaved edits alone.
  useEffect(() => {
    if (status == null) return
    const d0 = status.destinations[0] ?? ''
    const d1 = status.destinations[1] ?? ''
    if (d0 !== serverDest1Ref.current) {
      const prev = serverDest1Ref.current
      setDestination1(current => (current === prev ? d0 : current))
      serverDest1Ref.current = d0
    }
    if (d1 !== serverDest2Ref.current) {
      const prev = serverDest2Ref.current
      setDestination2(current => (current === prev ? d1 : current))
      serverDest2Ref.current = d1
    }
  }, [status])

  const handleEnter = useCallback((): void => {
    const trimmed = eventIdInput.trim()
    if (trimmed === '') return
    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
      setFeedback('Event ID may only contain letters, digits, _ and -')
      return
    }
    setFeedback('')
    const result = navigate(`/split/${trimmed}`)
    if (result instanceof Promise) {
      result.catch((err: unknown) => {
        console.error('Navigation error:', err)
      })
    }
  }, [eventIdInput, navigate])

  const copyIngress = useCallback((): void => {
    if (ingressUrl === '') return
    navigator.clipboard
      .writeText(ingressUrl)
      .then(() => {
        setIngressCopied(true)
        setTimeout(() => {
          setIngressCopied(false)
        }, 2000)
      })
      .catch((err: unknown) => {
        console.error('Copy failed:', err)
      })
  }, [ingressUrl])

  const saveDestinations = useCallback(async (): Promise<void> => {
    if (eventIdParam == null) return
    const dest1 = destination1.trim()
    const dest2 = destination2.trim()
    // Collect only the non-empty destinations. The splitter accepts 1
    // or 2 URLs, so leaving Destination 2 blank is a valid way to fan
    // out to a single endpoint.
    const destinations = [dest1, dest2].filter(d => d !== '')
    if (destinations.length === 0) {
      setFeedback('At least one destination is required.')
      return
    }
    setIsSaving(true)
    setFeedback('')
    try {
      const res = await fetch(`/api/v1/split/${eventIdParam}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destinations })
      })
      const json = await res.json()
      if (!res.ok) {
        setFeedback(json.error ?? `HTTP ${res.status}`)
      } else {
        setFeedback('Saved. Splitter is active for this event.')
        // Record the just-saved values as the new server baseline so
        // the auto-sync effect treats the imminent WS echo as a no-op,
        // and any *subsequent* remote change is still recognized as a
        // divergence and reflected in the inputs.
        serverDest1Ref.current = dest1
        serverDest2Ref.current = dest2
      }
    } catch (error) {
      setFeedback(`Save failed: ${String(error)}`)
    } finally {
      setIsSaving(false)
    }
  }, [eventIdParam, destination1, destination2])

  const stopSplit = useCallback(async (): Promise<void> => {
    if (eventIdParam == null) return
    setFeedback('')
    try {
      const res = await fetch(`/api/v1/split/${eventIdParam}`, {
        method: 'DELETE'
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        setFeedback(json.error ?? `HTTP ${res.status}`)
      } else {
        setFeedback('Stopped. Forwarding deactivated; destinations preserved.')
      }
    } catch (error) {
      setFeedback(`Stop failed: ${String(error)}`)
    }
  }, [eventIdParam])

  if (eventIdParam == null || eventIdParam === '') {
    return (
      <View style={styles.container}>
        <View style={styles.card}>
          <Image
            source={{ uri: '/assets/images/gs_logo.png' }}
            style={styles.logo as ImageStyle}
            resizeMode="contain"
          />
          <Text style={styles.title}>RTMP Splitter</Text>
          <Text style={styles.description}>
            Pick a unique event ID. The splitter will accept an RTMP publish at
            its ingress URL and forward it to two configured destinations
            without transcoding.
          </Text>
          <TextInput
            style={styles.input}
            placeholder="Enter an Event ID"
            placeholderTextColor={theme.placeholderTextColor}
            value={eventIdInput}
            onChangeText={setEventIdInput}
          />
          <Pressable style={styles.button} onPress={generateEventId}>
            <Text style={styles.buttonText}>Generate Event ID</Text>
          </Pressable>
          <Pressable
            style={[styles.button, styles.continueButton]}
            onPress={handleEnter}
          >
            <Text style={styles.buttonText}>Continue</Text>
          </Pressable>
          {feedback !== '' ? (
            <Text style={styles.feedbackText}>{feedback}</Text>
          ) : null}
        </View>
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Image
          source={{ uri: '/assets/images/gs_logo.png' }}
          style={styles.logo as ImageStyle}
          resizeMode="contain"
        />
        <Text style={styles.title}>RTMP Splitter</Text>
        <Text style={styles.eventIdText}>Event ID: {eventIdParam}</Text>

        <View style={styles.linkSection}>
          <Text style={styles.linkLabel}>Ingress URL (publish here):</Text>
          <View style={styles.linkRow}>
            <TextInput
              style={styles.linkInput}
              value={ingressUrl}
              editable={false}
              selectTextOnFocus
            />
            <Pressable style={styles.copyButton} onPress={copyIngress}>
              <Text style={styles.copyButtonText}>
                {ingressCopied ? '\u2713' : 'Copy'}
              </Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.linkSection}>
          <Text style={styles.linkLabel}>Destination 1:</Text>
          <TextInput
            style={styles.input}
            placeholder="rtmp://destination1.example.com/live/key1"
            placeholderTextColor={theme.placeholderTextColor}
            value={destination1}
            onChangeText={setDestination1}
            autoCapitalize="none"
          />
        </View>
        <View style={styles.linkSection}>
          <Text style={styles.linkLabel}>Destination 2 (optional):</Text>
          <TextInput
            style={styles.input}
            placeholder="rtmps://destination2.example.com/live/key2"
            placeholderTextColor={theme.placeholderTextColor}
            value={destination2}
            onChangeText={setDestination2}
            autoCapitalize="none"
          />
        </View>

        <View style={styles.buttonRow}>
          <Pressable
            style={[styles.navButton, styles.dashboardButton]}
            onPress={() => {
              saveDestinations().catch((err: unknown) => {
                console.error(err)
              })
            }}
          >
            <Text style={styles.navButtonText}>
              {isSaving ? 'Saving...' : 'Save / Activate'}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.navButton, styles.scoreboardButton]}
            onPress={() => {
              stopSplit().catch((err: unknown) => {
                console.error(err)
              })
            }}
          >
            <Text style={styles.navButtonText}>Stop</Text>
          </Pressable>
        </View>

        {feedback !== '' ? (
          <Text style={styles.feedbackText}>{feedback}</Text>
        ) : null}

        <View style={styles.statusSection}>
          <Text style={styles.linkLabel}>Status</Text>
          <IngressIndicator status={status} styles={styles} />
          {(status?.outbounds ?? []).map((o, i) => (
            <OutboundIndicator
              key={`${o.url}-${i}`}
              index={i}
              outbound={o}
              styles={styles}
            />
          ))}
          {status == null || status.outbounds.length === 0 ? (
            <Text style={styles.statusSecondary}>
              Save destinations to enable forwarding.
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  )
}

interface IndicatorProps {
  status: SplitStatus | null
  styles: ReturnType<typeof getStyles>
}

const IngressIndicator: React.FC<IndicatorProps> = ({ status, styles }) => {
  const ingress = status?.ingress
  let dotStyle = styles.statusDotGrey
  let label = 'Ingress: Waiting for publisher'
  if (ingress?.publishing === true) {
    if (ingress.receivingPackets) {
      dotStyle = styles.statusDotGreen
      label = `Ingress: Receiving (${formatBitrate(ingress.bytesPerSecond)})`
    } else {
      dotStyle = styles.statusDotYellow
      label = 'Ingress: Connected, no packets'
    }
  }
  return (
    <View style={styles.statusRow}>
      <View style={[styles.statusDot, dotStyle]} />
      <Text style={styles.statusLabel}>{label}</Text>
    </View>
  )
}

interface OutboundProps {
  index: number
  outbound: SplitOutboundStatus
  styles: ReturnType<typeof getStyles>
}

const OutboundIndicator: React.FC<OutboundProps> = ({
  index,
  outbound,
  styles
}) => {
  let dotStyle = styles.statusDotGrey
  let label = `Destination ${index + 1}: Idle`
  switch (outbound.state) {
    case 'connecting':
      dotStyle = styles.statusDotYellow
      label = `Destination ${index + 1}: Connecting${outbound.restartCount > 0 ? ` (retry ${outbound.restartCount})` : ''}...`
      break
    case 'connected':
      dotStyle = styles.statusDotGreen
      label = `Destination ${index + 1}: Connected (${formatBitrate(outbound.bytesPerSecond ?? 0)})`
      break
    case 'error':
      dotStyle = styles.statusDotRed
      label = `Destination ${index + 1}: Error - ${outbound.lastError ?? 'unknown'}`
      break
    case 'stopped':
      dotStyle = styles.statusDotGrey
      label = `Destination ${index + 1}: Stopped`
      break
    default:
      break
  }
  return (
    <View style={styles.statusRow}>
      <View style={[styles.statusDot, dotStyle]} />
      <Text style={styles.statusLabel}>{label}</Text>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  container: {
    flex: 1,
    minHeight: 600,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.backgroundColor
  },
  card: {
    alignItems: 'center',
    padding: theme.rem(2),
    backgroundColor: theme.cardBackgroundColor,
    borderRadius: theme.rem(1),
    shadowColor: theme.shadowColor,
    shadowOffset: { width: 0, height: theme.rem(1.25) },
    shadowOpacity: 0.1,
    shadowRadius: theme.rem(1.5),
    elevation: 10,
    width: '90%',
    maxWidth: 640,
    marginTop: theme.rem(2),
    marginBottom: theme.rem(2)
  },
  logo: {
    height: theme.rem(4),
    width: theme.rem(12.5),
    marginBottom: theme.rem(1.5)
  },
  title: {
    fontSize: theme.rem(1.75),
    fontWeight: '700',
    fontFamily: theme.boldTextFont,
    color: theme.secondaryTextColor,
    marginBottom: theme.rem(1)
  },
  description: {
    fontSize: theme.rem(1),
    fontFamily: theme.regularTextFont,
    color: theme.tertiaryTextColor,
    textAlign: 'center',
    marginBottom: theme.rem(1.5),
    lineHeight: theme.rem(1.5)
  },
  eventIdText: {
    fontSize: theme.rem(1.25),
    color: theme.primaryButtonColor,
    fontWeight: '600',
    fontFamily: theme.semiBoldTextFont,
    marginBottom: theme.rem(1.5)
  },
  input: {
    width: '100%',
    paddingVertical: theme.rem(1),
    paddingHorizontal: theme.rem(1),
    borderRadius: theme.rem(0.5),
    borderWidth: 2,
    borderColor: theme.inputBorderColor,
    fontSize: theme.rem(1),
    marginBottom: theme.rem(0.5),
    backgroundColor: theme.inputBackgroundColor,
    color: theme.inputTextColor
  },
  button: {
    width: '100%',
    paddingVertical: theme.rem(1),
    paddingHorizontal: theme.rem(1.5),
    borderRadius: theme.rem(0.5),
    backgroundColor: theme.primaryButtonColor,
    marginBottom: theme.rem(0.75),
    alignItems: 'center'
  },
  continueButton: {
    backgroundColor: theme.secondaryButtonColor
  },
  buttonText: {
    color: theme.buttonTextColor,
    fontWeight: '600',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1)
  },
  linkSection: {
    width: '100%',
    marginBottom: theme.rem(1)
  },
  linkLabel: {
    fontSize: theme.rem(1),
    fontWeight: '600',
    fontFamily: theme.semiBoldTextFont,
    color: theme.secondaryTextColor,
    marginBottom: theme.rem(0.5)
  },
  linkRow: {
    flexDirection: 'row',
    width: '100%',
    gap: theme.rem(0.5),
    alignItems: 'center'
  },
  linkInput: {
    flex: 1,
    minWidth: 0,
    flexShrink: 1,
    paddingVertical: theme.rem(0.75),
    paddingHorizontal: theme.rem(1),
    borderRadius: theme.rem(0.5),
    borderWidth: 2,
    borderColor: theme.inputBorderColor,
    fontSize: theme.rem(1),
    backgroundColor: theme.inputBackgroundColor,
    color: theme.inputTextColor
  },
  copyButton: {
    paddingVertical: theme.rem(0.75),
    paddingHorizontal: theme.rem(1.25),
    borderRadius: theme.rem(0.5),
    backgroundColor: theme.primaryButtonColor,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0
  },
  copyButtonText: {
    color: theme.buttonTextColor,
    fontWeight: '600',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1)
  },
  buttonRow: {
    flexDirection: 'row',
    width: '100%',
    gap: theme.rem(0.75),
    marginTop: theme.rem(0.5),
    marginBottom: theme.rem(1)
  },
  navButton: {
    flex: 1,
    paddingVertical: theme.rem(1),
    paddingHorizontal: theme.rem(1.5),
    borderRadius: theme.rem(0.5),
    alignItems: 'center'
  },
  dashboardButton: {
    backgroundColor: theme.primaryButtonColor
  },
  scoreboardButton: {
    backgroundColor: theme.secondaryButtonColor
  },
  navButtonText: {
    color: theme.buttonTextColor,
    fontWeight: '600',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1)
  },
  feedbackText: {
    fontSize: theme.rem(0.875),
    fontFamily: theme.regularTextFont,
    color: theme.tertiaryTextColor,
    textAlign: 'center',
    marginBottom: theme.rem(0.5)
  },
  statusSection: {
    width: '100%',
    marginTop: theme.rem(0.5),
    paddingTop: theme.rem(0.5),
    borderTopWidth: 1,
    borderTopColor: theme.inputBorderColor
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: theme.rem(0.4)
  },
  statusDot: {
    width: theme.rem(0.75),
    height: theme.rem(0.75),
    borderRadius: theme.rem(0.4),
    marginRight: theme.rem(0.75)
  },
  statusDotGrey: {
    backgroundColor: '#888888'
  },
  statusDotYellow: {
    backgroundColor: '#f0c040'
  },
  statusDotGreen: {
    backgroundColor: '#3cb371'
  },
  statusDotRed: {
    backgroundColor: '#d04040'
  },
  statusLabel: {
    flex: 1,
    fontSize: theme.rem(0.95),
    fontFamily: theme.regularTextFont,
    color: theme.secondaryTextColor
  },
  statusSecondary: {
    fontSize: theme.rem(0.875),
    fontFamily: theme.regularTextFont,
    color: theme.tertiaryTextColor,
    marginTop: theme.rem(0.5)
  }
}))

export default Splitter
