package app.teamstation.streamcore.stream

import android.view.Surface
import app.teamstation.streamcore.bitrate.AdaptiveBitrateController
import app.teamstation.streamcore.bitrate.AdaptiveBitrateLoop
import app.teamstation.streamcore.core.EncodedVideoFrame
import app.teamstation.streamcore.core.StreamCodec
import app.teamstation.streamcore.rtmp.FLVTag
import app.teamstation.streamcore.rtmp.HEVCDecoderConfiguration
import app.teamstation.streamcore.rtmp.RTMPClient
import app.teamstation.streamcore.rtmp.RTMPURL
import app.teamstation.streamcore.rtmp.RTMPVideoCodec
import java.io.ByteArrayOutputStream
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Encodes the programme with the stream's own settings and publishes it over RTMP. A port of TS
 * Director's `ProgramStreamer`, on MediaCodec.
 *
 * H.265 goes out in Enhanced RTMP, H.264 in classic FLV. The encoder runs at a constant rate at the
 * adaptive target: it starts at the high end of the operator's range and moves inside it with the
 * uplink, through `setParameters`, fed by the RTMP client's own send queue. The GOP is the settings'
 * (2 s), there are no B-frames, and IDRs are asked for with `REQUEST_SYNC_FRAME`.
 *
 * Pictures reach MediaCodec through its input surface, so where TS Director hands each picture to
 * `append`, a host here asks [append] whether to draw the next picture into [inputSurface]: that is
 * where the stream's frame pacing and its cap on pictures in the encoder apply. Every coded picture
 * is stamped on [StreamEncodeClock], the stream's wall-clock timeline, from when it was captured.
 */
class ProgramStreamer(
    private val telemetry: MediaTelemetry = MediaTelemetry.None,
    private val videoEncoderFactory: () -> StreamVideoEncoding = { MediaCodecStreamEncoder() },
    private val audioEncoderFactory: () -> StreamAudioEncoding = { MediaCodecAacEncoder() },
    private val clientFactory: () -> RTMPClient = { RTMPClient() },
    /**
     * The wall clock the mix and the pictures are timed on (the steady wall clock in the app): the
     * stream's video stamps and its sound's epoch are both taken from it.
     */
    private val wallClock: () -> Double = { System.currentTimeMillis() / 1000.0 },
    /**
     * The wall second a coded picture was captured, from its presentation time in seconds. Null
     * stamps a picture when it comes out of the encoder.
     */
    private val pictureWall: ((Double) -> Double)? = null
) : StreamPublishing {
    data class Metrics(
        val megabitsPerSecond: Double = 0.0,
        val droppedPackets: Long = 0,
        /** Bytes queued between this encoder and the socket. */
        val queuedBytes: Int = 0,
        /** Every byte the socket has taken since the publish began. */
        val bytesSent: Long = 0,
        /** The bitrate controller, as it last decided. */
        val rate: StreamRateTelemetry = StreamRateTelemetry()
    )

    private val lock = ReentrantLock()
    private var settings = StreamSettings()
    private var codec = RTMPVideoCodec.HEVC

    /** What the encoder has been told, which is where a rebuilt session starts too. */
    private var bitrate = settings.bitrateHigh
    private var client: RTMPClient? = null
    private var rateLoop: AdaptiveBitrateLoop? = null
    private var encoder: StreamVideoEncoding? = null
    private var aac: StreamAudioEncoding? = null
    private var isRunning = false
    private var sentVideoConfig = false
    private var sentAudioConfig = false
    private var sentMetadata = false
    private var parameterSets: List<ByteArray> = emptyList()

    /** The wall clock of the first sample of mix fed to the AAC encoder since it was reset. */
    private var audioInputWall: Double? = null

    /** Packets the AAC encoder has produced since it was reset, sent or not: the sound's clock. */
    private var audioPacketsSent = 0
    private var audioNextWall: Double? = null
    private var audioLastStamp: Long? = null
    private var clock = StreamEncodeClock()
    private var streamStartWall = 0.0
    private var lastOutputWall = 0.0
    private var pacer = StreamFramePacer(30)
    private var onFailure: ((String) -> Unit)? = null

    /** Pictures drawn into the encoder and not yet back: at most three, four for an IDR. */
    private var pendingEncodes = 0

    /** Set once an IDR has been asked of the running session, until one comes out. */
    private var syncRequested = false
    private var watchdog: ScheduledExecutorService? = null
    private var gopTimer: ScheduledFuture<*>? = null
    private var lastCallbackWall = 0.0
    private var lastProgramFrameWall = 0.0
    private var lastResetWall = 0.0
    private var surface: Surface? = null
    private var surfaceListener: ((Surface?) -> Unit)? = null

    override val running: Boolean get() = lock.withLock { isRunning }

    /** The surface the stream's pictures are drawn into; a new one after the watchdog rebuilds the session. */
    val inputSurface: Surface? get() = lock.withLock { surface }

    /** Told of every new input surface, and of null when the session closes. */
    fun onInputSurface(listener: ((Surface?) -> Unit)?) {
        lock.withLock { surfaceListener = listener }
    }

    override val metrics: Metrics
        get() {
            val (current, loop, activeCodec) = lock.withLock { Triple(client, rateLoop, codec) }
            val raw = current?.metrics ?: RTMPClient.Metrics()
            return Metrics(
                megabitsPerSecond = raw.megabitsPerSecond,
                droppedPackets = raw.droppedPackets,
                queuedBytes = raw.queuedBytes,
                bytesSent = raw.bytesSent,
                rate = loop?.let { rateTelemetry(it.status.controller, activeCodec) } ?: StreamRateTelemetry()
            )
        }

    override suspend fun start(urlString: String, settings: StreamSettings, onFailure: ((String) -> Unit)?) {
        val url = RTMPURL.require(urlString)
        if (!beginStart(settings, onFailure)) return

        openEncoder()
        val client = clientFactory()
        // How far behind the socket may fall before the client sheds media: the send buffer at the
        // top of the stream's range, which is the most this session ever produces.
        client.configure(
            sendBudgetBytes = RTMPClient.sendBudget(settings.bitrateHigh),
            videoCodec = RTMPVideoCodec.of(settings.codec)
        )
        client.onFailure { handleFailure(it.description) }
        markStarted(client)
        startRateLoop(client)
        telemetry.recordEncodeSessionChange(1)
        try {
            client.publish(url)
        } catch (error: Throwable) {
            stop()
            throw error
        }
    }

    private fun beginStart(settings: StreamSettings, onFailure: ((String) -> Unit)?): Boolean = lock.withLock {
        if (isRunning) return false
        applyStreamSettings(settings)
        this.onFailure = onFailure
        sentVideoConfig = false
        sentAudioConfig = false
        sentMetadata = false
        parameterSets = emptyList()
        audioInputWall = null
        audioPacketsSent = 0
        audioNextWall = null
        audioLastStamp = null
        clock = StreamEncodeClock(this.settings.frameRate, this.settings.gopSeconds)
        pacer = StreamFramePacer(this.settings.frameRate)
        aac?.close()
        aac = audioEncoderFactory()
        lastCallbackWall = 0.0
        lastProgramFrameWall = 0.0
        lastResetWall = 0.0
        streamStartWall = wallClock()
        lastOutputWall = 0.0
        pendingEncodes = 0
        syncRequested = false
        true
    }

    private fun applyStreamSettings(settings: StreamSettings) {
        this.settings = settings.copy(frameRate = maxOf(1, settings.frameRate))
        codec = RTMPVideoCodec.of(settings.codec)
        bitrate = this.settings.openingBitrate
    }

    /** The next coded picture must be an IDR. */
    fun requestKeyframe() {
        val running = lock.withLock {
            clock.requestKeyframe()
            syncRequested = true
            encoder
        }
        running?.requestSyncFrame()
    }

    /**
     * Starts the controller at the opening bitrate, which is where the session already is. Until the
     * publish is live there is no link to judge, and the controller holds.
     */
    private fun startRateLoop(client: RTMPClient) {
        val (high, low, opening) = lock.withLock { Triple(settings.bitrateHigh, settings.bitrateLow, bitrate) }
        val loop = AdaptiveBitrateLoop(
            ceiling = high,
            floor = low,
            tuning = RTMPClient.adaptiveBitrateTuning,
            sample = { if (client.isLive) client.congestionSample() else null },
            apply = { applyBitrate(it) }
        )
        lock.withLock { rateLoop = loop }
        loop.configure(high, low, enabled = true, start = opening)
    }

    /** A rate from the controller, onto the live session: the next picture is coded at it. */
    private fun applyBitrate(rate: Int) {
        val running = lock.withLock {
            if (!isRunning) return
            bitrate = rate
            encoder
        }
        running?.setBitrate(rate)
    }

    private fun markStarted(client: RTMPClient) {
        lock.withLock {
            this.client = client
            isRunning = true
        }
        startGOPWatchdog()
    }

    override fun stop() {
        val (wasRunning, closing) = lock.withLock {
            val wasRunning = isRunning
            isRunning = false
            gopTimer?.cancel(false)
            gopTimer = null
            watchdog?.shutdown()
            watchdog = null
            pendingEncodes = 0
            val closing = Closing(encoder, client, rateLoop, aac, surfaceListener.takeIf { encoder != null })
            encoder = null
            client = null
            rateLoop = null
            aac = null
            surface = null
            wasRunning to closing
        }
        closing.loop?.stop()
        closing.encoder?.close()
        closing.audio?.close()
        closing.client?.stop()
        closing.surfaceListener?.invoke(null)
        if (wasRunning) telemetry.recordEncodeSessionChange(-1)
    }

    private class Closing(
        val encoder: StreamVideoEncoding?,
        val client: RTMPClient?,
        val loop: AdaptiveBitrateLoop?,
        val audio: StreamAudioEncoding?,
        val surfaceListener: ((Surface?) -> Unit)?
    )

    /**
     * Whether the host should draw the next programme picture into [inputSurface]: TS Director's
     * `append`. Held to the stream's frame rate by [StreamFramePacer], and refused while the encoder
     * already holds three pictures (four when the next must be an IDR), so a slow encoder cannot
     * collect a queue at programme rate. A picture refused here was never encoded, so no reference is
     * broken and no IDR is owed.
     */
    fun append(presentationTime: Double): Boolean {
        val (running, ask) = lock.withLock {
            if (!isRunning || encoder == null) return false
            val now = wallClock()
            if (!pacer.admit(now)) return false
            lastProgramFrameWall = now
            telemetry.recordProgramFrameAge(0.0)
            val mustKey = clock.shouldForceKey(clock.timeNow(now), now) || !sentVideoConfig
            telemetry.recordStreamKeyframeAge(clock.keyframeAgeSeconds(now))
            val cap = if (mustKey) idleIDRPendingCap else maximumPendingEncodes
            if (pendingEncodes >= cap) {
                telemetry.recordStreamPendingEncodes(pendingEncodes)
                return false
            }
            pendingEncodes += 1
            telemetry.recordStreamPendingEncodes(pendingEncodes)
            val ask = mustKey && !syncRequested
            if (ask) syncRequested = true
            encoder to ask
        }
        if (ask) running?.requestSyncFrame()
        return true
    }

    private fun startGOPWatchdog() {
        val interval = lock.withLock { minOf(0.25, settings.gopSeconds / 4) }
        val executor = Executors.newSingleThreadScheduledExecutor { Thread(it, "stream-gop").apply { isDaemon = true } }
        val millis = (interval * 1000).toLong()
        val timer = executor.scheduleWithFixedDelay({ runCatching { gopWatchdogTick() } }, millis, millis, TimeUnit.MILLISECONDS)
        lock.withLock {
            watchdog?.shutdown()
            watchdog = executor
            gopTimer = timer
        }
    }

    internal fun gopWatchdogTick() {
        val action = lock.withLock {
            if (!isRunning) return
            val now = wallClock()
            telemetry.recordStreamKeyframeAge(clock.keyframeAgeSeconds(now))
            telemetry.recordStreamPendingEncodes(pendingEncodes)
            telemetry.recordStreamEncodeCallbackAge(if (lastCallbackWall > 0) maxOf(0.0, now - lastCallbackWall) else 0.0)
            telemetry.recordProgramFrameAge(if (lastProgramFrameWall > 0) maxOf(0.0, now - lastProgramFrameWall) else 0.0)
            StreamStallPolicy(settings.gopSeconds).action(
                now = now,
                lastKeyframeWall = clock.lastKeyframeWall,
                lastCallbackWall = lastCallbackWall,
                pendingEncodes = pendingEncodes,
                hasLastFrame = lastOutputWall > 0,
                lastResetWall = lastResetWall,
                startedWall = streamStartWall,
                lastOutputWall = lastOutputWall
            )
        }
        when (action) {
            StreamStallAction.NONE -> Unit
            StreamStallAction.RESET_SESSION -> {
                resetWedgedSession()
                encodeIdleIDR()
            }
            StreamStallAction.ENCODE_IDLE_IDR -> encodeIdleIDR()
        }
    }

    /**
     * An IDR of the last picture, to keep an idle stream decodable: the session repeats its last
     * picture when no new one arrives (`KEY_REPEAT_PREVIOUS_FRAME_AFTER`), and this makes the next one
     * a keyframe.
     */
    private fun encodeIdleIDR() {
        val running = lock.withLock {
            if (!isRunning) return
            clock.requestKeyframe()
            syncRequested = true
            telemetry.recordStreamIdleKeyframe()
            encoder
        }
        running?.requestSyncFrame()
    }

    private fun resetWedgedSession() {
        val old = lock.withLock {
            if (!isRunning) return
            val old = encoder
            encoder = null
            surface = null
            pendingEncodes = 0
            sentVideoConfig = false
            parameterSets = emptyList()
            clock.requestKeyframe()
            lastResetWall = wallClock()
            telemetry.recordStreamPendingEncodes(0)
            telemetry.recordStreamEncoderReset()
            old
        }
        old?.close()
        try {
            openEncoder()
        } catch (error: Exception) {
            handleFailure(error.message ?: error.javaClass.simpleName)
        }
    }

    /**
     * The programme mix, onto the stream. Each AAC packet is stamped where the sound it decodes to
     * belongs on the stream's clock: the mix says when its first sample plays, the count says where
     * the packet sits after it, less the encoder's priming. After a break in the mix the encoder
     * starts again from that frame's own time, and no stamp goes at or before one already sent.
     */
    fun append(audio: AudioFrame) {
        val sendable = mutableListOf<Pair<ByteArray, Long>>()
        val (client, cookie, sentAudio) = lock.withLock {
            val client = client ?: return
            val encoder = aac ?: return
            if (!isRunning || !client.isLive) return
            if (StreamAudioStamps.audioBreaks(audioNextWall, audio.wallClock)) {
                encoder.reset()
                audioInputWall = null
            }
            if (audioInputWall == null) {
                audioInputWall = audio.wallClock
                audioPacketsSent = 0
            }
            audioNextWall = audio.wallClock + audio.durationSeconds
            val packets = encoder.encode(audio.samples)
            val first = audioPacketsSent
            audioPacketsSent += packets.size
            val inputWall = audioInputWall
            if (!sentVideoConfig || clock.startWall == 0.0 || inputWall == null) return
            val epoch = StreamAudioStamps.audioEpochMilliseconds(inputWall, clock.startWall, encoder.primingSamples)
            val stamps = StreamAudioStamps.audioTimestamps(packets.size, first, epoch)
            // Never at or before what already went: a restart's priming reaches back over it.
            StreamAudioStamps.monotonicAudioStamps(stamps, audioLastStamp).forEachIndexed { index, stamp ->
                if (stamp != null) {
                    sendable += packets[index] to stamp
                    audioLastStamp = stamp
                }
            }
            val sentAudio = sentAudioConfig
            if (sendable.isNotEmpty()) sentAudioConfig = true
            Triple(client, encoder.audioSpecificConfig, sentAudio)
        }
        val firstStamp = sendable.firstOrNull()?.second
        if (!sentAudio && firstStamp != null) client.sendAudio(firstStamp, FLVTag.audio(0, cookie))
        for ((packet, stamp) in sendable) client.sendAudio(stamp, FLVTag.audio(1, packet))
    }

    private fun openEncoder() {
        val config = lock.withLock {
            StreamEncoderConfig(settings.codec, settings.width, settings.height, settings.frameRate, bitrate, settings.gopSeconds)
        }
        val session = videoEncoderFactory()
        val opened = session.open(
            config,
            object : StreamVideoEncoding.Output {
                override fun onFrame(frame: EncodedVideoFrame) = didEncode(session, frame)
                override fun onError(code: Int, message: String) = didFail(session, code)
            }
        )
        val listener = lock.withLock {
            encoder = session
            surface = opened
            surfaceListener
        }
        listener?.invoke(opened)
    }

    private fun didFail(session: StreamVideoEncoding, code: Int) {
        lock.withLock {
            if (encoder !== session) return
            pendingEncodes = maxOf(0, pendingEncodes - 1)
            lastCallbackWall = wallClock()
            telemetry.recordStreamPendingEncodes(pendingEncodes)
            telemetry.recordStreamEncodeCallbackAge(0.0)
            telemetry.recordEncodeFailure(code)
            clock.requestKeyframe()
        }
    }

    internal fun didEncode(session: StreamVideoEncoding, frame: EncodedVideoFrame) {
        val now = wallClock()
        val keyframe: Boolean
        val time: MediaTime
        lock.withLock {
            if (encoder !== session) return
            pendingEncodes = maxOf(0, pendingEncodes - 1)
            lastCallbackWall = now
            telemetry.recordStreamPendingEncodes(pendingEncodes)
            telemetry.recordStreamEncodeCallbackAge(0.0)
            if (frame.nalUnits.isEmpty()) {
                clock.requestKeyframe()
                return
            }
            lastOutputWall = now
            if (frame.parameterSets.isNotEmpty()) parameterSets = frame.parameterSets
            keyframe = frame.isKeyframe || payloadContainsIDR(frame.nalUnits, settings.codec)
            val captured = pictureWall?.invoke(frame.presentationTime) ?: now
            time = clock.nextPresentationTime(MediaTime.seconds(frame.presentationTime, 1_000_000), captured)
            if (keyframe) {
                clock.noteKeyframe(time, now)
                syncRequested = false
                telemetry.recordStreamKeyframe(0.0)
            } else {
                telemetry.recordStreamKeyframeAge(clock.keyframeAgeSeconds(now))
            }
        }
        val (client, metadata, header) = lock.withLock {
            val client = client
            if (!isRunning || client == null || !client.isLive) return
            val metadata = if (!sentMetadata) {
                sentMetadata = true
                settings
            } else {
                null
            }
            var header: ByteArray? = null
            if (!sentVideoConfig) {
                val record = if (keyframe) decoderConfigurationRecord(parameterSets, codec) else null
                if (record == null) return
                sentVideoConfig = true
                header = FLVTag.videoSequenceHeader(codec, record)
            }
            Triple(client, metadata, header)
        }
        if (metadata != null) client.sendMetadata(metadata.width, metadata.height, metadata.frameRate, metadata.bitrateHigh)
        val timestamp = milliseconds(time)
        if (header != null) client.sendVideo(timestamp, header)
        val outcome = client.sendVideo(timestamp, FLVTag.videoFrame(codec, keyframe, lengthPrefixed(frame.nalUnits)))
        // Only when the client waits for a keyframe to resume on; asking on every over-budget drop
        // would force an IDR per frame while the link is still saturated.
        if (outcome == RTMPClient.SendOutcome.DROPPED_AWAITING_KEYFRAME) requestKeyframe()
    }

    private fun handleFailure(message: String) {
        val handler = lock.withLock { onFailure }
        stop()
        handler?.invoke(message)
    }

    /** Puts the streamer live on [client] with a session from the factory, without a publish. */
    internal fun goLiveForTesting(client: RTMPClient, settings: StreamSettings, startWall: Double? = null) {
        beginStart(settings, null)
        openEncoder()
        lock.withLock {
            this.client = client
            isRunning = true
            if (startWall != null) {
                sentVideoConfig = true
                clock.nextPresentationTime(MediaTime.zero, startWall)
            }
        }
    }

    internal val pendingEncodesForTesting: Int get() = lock.withLock { pendingEncodes }

    companion object {
        /** A slow ingest must not let the encoder collect pictures at programme rate. */
        const val maximumPendingEncodes = 3

        /** One reserved slot, so an IDR that is due is not blocked by three pictures ahead of it. */
        const val idleIDRPendingCap = 4

        fun rateTelemetry(status: AdaptiveBitrateController.Status, codec: RTMPVideoCodec): StreamRateTelemetry =
            StreamRateTelemetry(
                codec = codec.rawValue,
                bitrate = status.bitrate,
                low = status.floor,
                high = status.ceiling,
                lastDecision = status.lastDecision.rawValue,
                queueMilliseconds = status.queueDelayMilliseconds,
                deliveryBitsPerSecond = status.deliveryBitsPerSecond ?: 0,
                transportBaseMilliseconds = status.transportBaseMilliseconds,
                decreases = status.decreases,
                increases = status.increases
            )

        /**
         * Whether a picture can be decoded on its own. For H.264, NAL type 5 (IDR); for H.265 any IRAP
         * picture, types 16 to 23 (BLA, IDR, CRA).
         */
        fun payloadContainsIDR(nalUnits: List<ByteArray>, codec: StreamCodec): Boolean = nalUnits.any { unit ->
            if (unit.isEmpty()) return@any false
            val first = unit[0].toInt() and 0xFF
            when (codec) {
                StreamCodec.H264 -> first and 0x1F == 5
                StreamCodec.HEVC -> (first ushr 1) and 0x3F in 16..23
            }
        }

        /** The sequence header's record: `hvcC` from VPS, SPS and PPS, or the AVC record. */
        fun decoderConfigurationRecord(parameterSets: List<ByteArray>, codec: RTMPVideoCodec): ByteArray? =
            when (codec) {
                RTMPVideoCodec.HEVC -> HEVCDecoderConfiguration.record(parameterSets)
                RTMPVideoCodec.H264 -> {
                    val sps = parameterSets.firstOrNull { it.isNotEmpty() && it[0].toInt() and 0x1F == 7 }
                    val pps = parameterSets.firstOrNull { it.isNotEmpty() && it[0].toInt() and 0x1F == 8 }
                    if (sps != null && pps != null) FLVTag.avcDecoderConfigurationRecord(sps, pps) else null
                }
            }

        /** Elementary NAL units as the length-prefixed samples FLV carries. */
        fun lengthPrefixed(nalUnits: List<ByteArray>): ByteArray {
            val out = ByteArrayOutputStream(nalUnits.sumOf { it.size + 4 })
            for (unit in nalUnits) {
                out.write((unit.size ushr 24) and 0xFF)
                out.write((unit.size ushr 16) and 0xFF)
                out.write((unit.size ushr 8) and 0xFF)
                out.write(unit.size and 0xFF)
                out.write(unit)
            }
            return out.toByteArray()
        }

        private fun milliseconds(time: MediaTime): Long = if (time.isNumeric) maxOf(0L, (time.seconds * 1000).toLong()) else 0L
    }
}
