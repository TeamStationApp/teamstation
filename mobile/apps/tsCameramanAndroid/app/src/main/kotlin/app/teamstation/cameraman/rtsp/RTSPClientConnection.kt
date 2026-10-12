package app.teamstation.cameraman.rtsp

import app.teamstation.cameraman.core.DeviceIdentity
import app.teamstation.cameraman.core.EncodedAudioFrame
import app.teamstation.cameraman.core.EncodedVideoFrame
import app.teamstation.cameraman.core.StreamCodec
import app.teamstation.cameraman.encode.AudioEncoder
import java.io.OutputStream
import java.net.Socket
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.random.Random

/**
 * One connected client: the RTSP exchange, then interleaved media.
 *
 * All mutable state lives on this connection's own single-thread executor, so it needs no locking.
 * The encoder's callbacks hop onto that executor rather than touching this directly.
 *
 * The split between that executor and a separate writer thread is what replaces `NWConnection`'s
 * async `send(completion:)`. A blocking `OutputStream.write` to a client that has stopped reading
 * would otherwise stall the encoder callback that called it — and then every other client with it.
 * So the executor frames, puts the bytes in [sendQueue], and the writer takes them from there as
 * the transport has room, dropping what has waited too long; see [MediaSendQueue].
 */
internal class RTSPClientConnection(
    private val socket: Socket,
    private val sdp: (Long, Long) -> String,
    hasAudio: Boolean,
    private val identity: () -> DeviceIdentity,
    private val requestKeyframe: () -> Unit,
    private val parameters: RTSPParameterHandler? = null,
    /**
     * The TCP send buffer to ask for, or null for the platform's own. See [start] for why a small
     * one is what makes the congestion signal honest.
     */
    private val sendBufferBytes: Int? = null,
    /** The boot clock, in seconds, which capture times are stamped on. */
    private val clock: () -> Double = { android.os.SystemClock.elapsedRealtimeNanos() / 1_000_000_000.0 },
    /** The system clock, in milliseconds since 1970, which sender reports carry. */
    private val wallClock: () -> Long = System::currentTimeMillis
) {
    private val queue: ExecutorService =
        Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "rtsp-conn") }
    /** Everything waiting for the writer, guarded by [sendLock]; [sendReady] wakes the writer. */
    val sendQueue = MediaSendQueue()
    private val gate = TransportGate()
    private val sendLock = ReentrantLock()
    private val sendReady = sendLock.newCondition()
    /** The writer drains what waits and stops: a TEARDOWN answered. */
    private var closeAfterDrain = false
    /** The writer stops at once, abandoning what waits. */
    private var abandon = false
    private var writerThread: Thread? = null
    private var readerThread: Thread? = null
    private lateinit var output: OutputStream

    private var responder: RTSPResponder

    private var buffer = ByteArray(0)

    /**
     * True between PLAY and PAUSE/TEARDOWN. The server counts only these as clients, so a
     * control-only connection polling parameters is not shown to the operator as a viewer.
     */
    @Volatile
    var isStreaming = false
        private set(value) {
            val changed = field != value
            field = value
            if (changed) onStreamingChange?.invoke()
        }
    private var isAwaitingKeyframe = false
    private var videoSetup: RTSPResponder.Setup? = null
    private var audioSetup: RTSPResponder.Setup? = null

    private val videoSSRC: Long = Random.nextLong(1, 0xFFFFFFFFL)
    private val audioSSRC: Long = Random.nextLong(1, 0xFFFFFFFFL)
    private var videoPacketCount = 0L
    private var videoOctetCount = 0L
    /** Audio stamps by capture position; made at the first frame, when the rate is known. */
    private var audioStamps: AudioStampClock? = null
    private var audioPacketCount = 0L
    private var audioOctetCount = 0L
    private val audioReports = SenderReportSchedule()
    private var firstVideoPresentationTime: Double? = null
    private val videoTimestamps = RTPTimestampSequencer()
    private val videoReports = SenderReportSchedule()

    /**
     * Wall clock minus the capture clock, sampled once per connection.
     *
     * Capture times are on the boot clock, [clock]: the camera stamps pictures on it (its timestamp
     * source is REALTIME) and the microphone is read on it. NTP is wall clock. The difference is taken
     * against that same boot clock, never `System.nanoTime()`, which stops while the phone sleeps and
     * so would put every report off by the phone's sleep since boot.
     *
     * Sampling the difference once and reusing it keeps successive reports on a single mapping, so a
     * receiver regressing RTP against NTP sees the camera's own rate rather than this app's clock
     * reads.
     */
    private val captureToWallOffsetMillis: Long by lazy {
        wallClock() - Math.round(clock() * 1000)
    }

    /** Written on the executor, read by the bitrate loop's thread; the lock is its own. */
    private val congestion = CongestionMeter()

    /** The kernel's side of the queue, when the platform lets it be read. */
    private var socketQueue: SocketQueue? = null
    private var closeReason = "cancelled"
    private var isClosed = false

    var onClose: ((String) -> Unit)? = null

    /** Fired on this connection's executor whenever [isStreaming] flips, so the server can recount. */
    var onStreamingChange: (() -> Unit)? = null

    init {
        // Distinct SSRCs per connection, so two clients watching at once are separable in a capture.
        responder = RTSPResponder(
            sessionIdentifier = RTSPResponder.generateSessionIdentifier(),
            sdp = sdp(videoSSRC, audioSSRC),
            hasAudio = hasAudio,
            parameters = parameters
        )
    }

    fun start() {
        // Nagle would hold a small RTSP response back waiting for more to coalesce with, which on a
        // request/response exchange is up to 40 ms of dead time per method.
        runCatching { socket.tcpNoDelay = true }
        // A client that vanished without a FIN would otherwise hold a thread and a send queue open
        // until the OS gave up, which on Wi-Fi is minutes.
        runCatching { socket.soTimeout = 0 }
        // Linux autotunes the send buffer to megabytes, seconds of video at these rates, and bytes
        // in the kernel can no longer be dropped for a fresher picture. A buffer of about a quarter
        // second at the ceiling keeps most of a backlog on this side, where stale frames can still
        // be discarded — Goel et al. (IWQoS 2002) measured the same fix for latency-sensitive media
        // over TCP — while leaving room for a round trip of 250 ms at the full rate. Set before the
        // first write, while it can still take effect.
        sendBufferBytes?.let { bytes -> runCatching { socket.sendBufferSize = bytes } }
        socketQueue = SocketQueue.open(socket)
        // Once per client, so a sandbox that refuses the read is visible in logcat rather than
        // showing up only as a controller that reacts late.
        android.util.Log.i("TSCameraman", "kernel send queue readable: ${socketQueue != null}")
        output = socket.getOutputStream()

        writerThread = Thread({ writeLoop() }, "rtsp-write").apply { isDaemon = true; start() }
        readerThread = Thread({ readLoop() }, "rtsp-read").apply { isDaemon = true; start() }
    }

    fun close(reason: String = "server stop") {
        submit {
            if (isClosed) return@submit
            closeReason = reason
            shutdown()
        }
    }

    private fun submit(work: () -> Unit) {
        // A frame that arrives while the connection is being torn down is not an error; the encoder
        // does not know the client has gone until this returns.
        try {
            queue.execute(work)
        } catch (_: RejectedExecutionException) {
        }
    }

    /**
     * Immediate teardown: whatever is still queued is abandoned. The graceful path — answering a
     * TEARDOWN before the socket goes — sets [closeAfterDrain] behind the response instead, so the
     * writer drains in order and the client gets its answer.
     */
    private fun shutdown() {
        if (isClosed) return
        isClosed = true
        // A flag rather than an interrupt: an interrupted write leaves the socket in an
        // indeterminate state, and this one is being closed anyway.
        sendLock.withLock {
            sendQueue.reset()
            abandon = true
            sendReady.signalAll()
        }
        socketQueue?.close()
        runCatching { socket.close() }
        val callback = onClose
        onClose = null
        queue.shutdown()
        callback?.invoke(closeReason)
    }

    // MARK: - Reading

    private fun readLoop() {
        val chunk = ByteArray(8 * 1024)
        try {
            val input = socket.getInputStream()
            while (true) {
                val read = input.read(chunk)
                if (read < 0) {
                    submit {
                        closeReason = "eof"
                        shutdown()
                    }
                    return
                }
                if (read == 0) continue
                val received = chunk.copyOf(read)
                submit {
                    buffer += received
                    drainRequests()
                }
            }
        } catch (error: Exception) {
            submit {
                if (!isClosed) {
                    closeReason = "recv: ${error.message ?: error.javaClass.simpleName}"
                    shutdown()
                }
            }
        }
    }

    private fun drainRequests() {
        // A client may pipeline several requests into one segment, and the buffer may hold a partial
        // one at the end, so this loops until nothing more can be parsed rather than assuming one
        // per read.
        while (true) {
            val parsed = RTSPServerRequest.parse(buffer) ?: return
            buffer = buffer.copyOfRange(parsed.consumed, buffer.size)
            handle(parsed.request)
            if (isClosed) return
        }
    }

    private fun handle(request: RTSPServerRequest) {
        // The SDP is regenerated per DESCRIBE, since the parameter sets are unknown until the encoder
        // has produced a frame and a client may connect before then.
        if (request.method == "DESCRIBE") {
            responder = RTSPResponder(
                sessionIdentifier = responder.sessionIdentifier,
                sdp = sdp(videoSSRC, audioSSRC),
                hasAudio = responder.hasAudio,
                parameters = parameters
            )
        }

        val outcome = responder.respond(request)

        when (val effect = outcome.effect) {
            is RTSPResponder.Effect.StartStreaming -> {
                videoSetup = effect.video
                audioSetup = effect.audio
                // Each client gets its own SSRC and its own timeline, so a client that joins an hour
                // in still starts at zero and RTP-Info can promise that.
                firstVideoPresentationTime = null
                sendLock.withLock { sendQueue.reset() }
                videoTimestamps.reset()
                audioStamps = null
                videoReports.reset()
                audioReports.reset()

                val response = outcome.response.adding(
                    "RTP-Info",
                    rtpInfo(request.uri, effect.audio != null)
                )
                write(response.wireFormat)

                isStreaming = true
                // Nothing before the next keyframe is decodable by a client that just joined, and
                // sending it makes a decoder report broken references rather than simply waiting.
                isAwaitingKeyframe = true
                requestKeyframe()
            }
            RTSPResponder.Effect.StopStreaming -> {
                write(outcome.response.wireFormat)
                isStreaming = false
            }
            RTSPResponder.Effect.Close -> {
                isStreaming = false
                closeReason = "TEARDOWN"
                // The response goes out first and the writer stops behind it, because the writer
                // drains in order. Closing the socket here instead would discard the response, and
                // the client would then wait out its TEARDOWN timeout on a connection the server has
                // already forgotten. `writeLoop` calls `shutdown` once it has drained.
                write(outcome.response.wireFormat)
                sendLock.withLock {
                    closeAfterDrain = true
                    sendReady.signalAll()
                }
            }
            RTSPResponder.Effect.None -> write(outcome.response.wireFormat)
        }
    }

    /**
     * RFC 2326 §12.33. Tells the client which sequence number and RTP timestamp each track will
     * start at, which is what it uses to line the two up before the first RTCP sender report
     * arrives.
     *
     * Only honest because the timelines are reset immediately above; promising a start the sender
     * does not honour is worse than sending no header at all.
     */
    private fun rtpInfo(uri: String, hasAudio: Boolean): String {
        val base = if (uri.endsWith("/")) uri.dropLast(1) else uri
        val tracks = mutableListOf(
            "url=$base/${SDPBuilder.videoTrackControl};seq=${sequence(videoSetup)};rtptime=0"
        )
        if (hasAudio) {
            tracks.add("url=$base/${SDPBuilder.audioTrackControl};seq=${sequence(audioSetup)};rtptime=0")
        }
        return tracks.joinToString(",")
    }

    private fun sequence(setup: RTSPResponder.Setup?): Int =
        setup?.let { sendLock.withLock { sendQueue.nextSequence(it.dataChannel) } } ?: 0

    // MARK: - Writing

    /** An RTSP response or a sender report: ahead of pictures, never dropped. */
    private fun write(data: ByteArray) {
        if (isClosed || data.isEmpty()) return
        sendLock.withLock {
            sendQueue.enqueueControl(data, clock())
            sendReady.signalAll()
        }
    }

    /**
     * Takes from [sendQueue] whatever may go now and writes it. Media goes only while
     * [TransportGate] says the kernel has room, so a backlog waits in the queue, where what grows too
     * old is dropped, rather than in the kernel, where nothing can be.
     */
    private fun writeLoop() {
        try {
            while (true) {
                var wantsKeyframe = false
                val next = sendLock.withLock {
                    var found: MediaSendQueue.Next? = null
                    while (found == null) {
                        if (abandon) return
                        val now = clock()
                        if (sendQueue.prune(now)) wantsKeyframe = true
                        val backlog = socketQueue?.queuedBytes() ?: 0
                        gate.observe(now, backlog)
                        found = sendQueue.next(closeAfterDrain || gate.hasRoom(backlog))
                        if (found != null) break
                        if (closeAfterDrain && sendQueue.isEmpty) return
                        if (wantsKeyframe) break
                        if (sendQueue.isEmpty) sendReady.await() else sendReady.await(retryMillis, TimeUnit.MILLISECONDS)
                    }
                    found
                }
                if (wantsKeyframe) submit { requestKeyframe() }
                if (next == null) continue
                if (next.isMedia) synchronized(congestion) { congestion.sent(next.bytes.size, clock()) }
                output.write(next.bytes)
                output.flush()
                sendLock.withLock {
                    gate.handed(next.bytes.size)
                    gate.processed(next.bytes.size)
                }
                if (next.isMedia) synchronized(congestion) { congestion.delivered() }
            }
        } catch (error: Exception) {
            submit {
                if (!isClosed) {
                    closeReason = "send: ${error.message ?: error.javaClass.simpleName}"
                }
            }
        } finally {
            // However this thread ends — drained, broken pipe, closed socket — the connection is done.
            // `shutdown` is idempotent, so the read side racing to the same conclusion is harmless.
            submit { shutdown() }
        }
    }

    // MARK: - Media

    fun send(frame: EncodedVideoFrame, codec: StreamCodec) {
        submit {
            val setup = videoSetup
            if (!isStreaming || setup == null || isClosed) return@submit
            if (isAwaitingKeyframe) {
                if (!frame.isKeyframe) return@submit
                isAwaitingKeyframe = false
            }

            val payloads = when (codec) {
                StreamCodec.H264 -> H264Packetizer().payloads(frame)
                StreamCodec.HEVC -> HEVCPacketizer().payloads(frame)
            }
            if (payloads.isEmpty()) return@submit

            val bytes = payloads.sumOf { it.size }
            synchronized(congestion) { congestion.offered(bytes) }

            if (firstVideoPresentationTime == null) firstVideoPresentationTime = frame.presentationTime
            val elapsed = frame.presentationTime - (firstVideoPresentationTime ?: frame.presentationTime)
            val natural = (elapsed * H264Packetizer.clockRate).toLong() and 0xFFFFFFFFL

            // A receiver treats a timestamp change as the end of a picture, so two frames sharing one
            // are merged into a single malformed access unit. The capture clock does occasionally
            // repeat a presentation time, so the sent timestamp is forced to advance — measured on
            // the 32-bit circle, because the field's own rollover is a forward step, not a repeat.
            val timestamp = videoTimestamps.next(natural)
            // The session's first picture goes out behind a sender report, so the receiver can place it.
            if (videoReports.reportBeforeFirstPacket(System.currentTimeMillis())) {
                sendVideoReport(setup, timestamp, frame.presentationTime)
            }

            val writer = RTPPacketWriter(SDPBuilder.videoPayloadType, videoSSRC)
            val packets = ArrayList<ByteArray>(payloads.size)
            for ((index, payload) in payloads.withIndex()) {
                // The marker bit goes on the last packet of the picture, which is how the receiver
                // knows the frame is complete without waiting for the next timestamp. The sequence
                // number is written as the packet is handed over; see [MediaSendQueue].
                val packet = writer.packet(
                    sequenceNumber = 0,
                    timestamp = timestamp,
                    marker = index == payloads.size - 1,
                    payload = payload
                )
                videoPacketCount += 1
                videoOctetCount += payload.size
                InterleavedFramer.frame(setup.dataChannel, packet)?.let { packets.add(it) }
            }

            val wantsKeyframe = sendLock.withLock {
                sendQueue.enqueuePicture(packets, frame.presentationTime, frame.isKeyframe, clock())
                    .also { sendReady.signalAll() }
            }
            // Nothing more goes out until a keyframe, so ask for one now rather than leaving the
            // client without pictures for the rest of the GOP.
            if (wantsKeyframe) requestKeyframe()
            if (videoReports.reportIsDue(System.currentTimeMillis())) {
                sendVideoReport(setup, timestamp, frame.presentationTime)
            }
        }
    }

    fun send(frame: EncodedAudioFrame) {
        submit {
            val setup = audioSetup
            if (!isStreaming || setup == null || isClosed) return@submit
            val payload = AACPacketizer().payload(frame) ?: return@submit

            val writer = RTPPacketWriter(SDPBuilder.audioPayloadType, audioSSRC)
            // Stamped by where its samples were captured: a dropout becomes a skip in the stamps at
            // the place it happened, rather than every later stamp sitting early by it.
            val capture = (frame.captureTime ?: frame.presentationTime) + AudioStampClock.captureTrimSeconds
            val stamps = audioStamps ?: AudioStampClock(frame.sampleRate.toDouble()).also { audioStamps = it }
            val timestamp = stamps.next(capture)
            if (audioReports.reportBeforeFirstPacket(System.currentTimeMillis())) {
                sendAudioReport(setup, timestamp, capture)
            }
            val packet = writer.packet(
                sequenceNumber = 0,
                timestamp = timestamp,
                marker = true,
                payload = payload
            )
            audioPacketCount += 1
            audioOctetCount += payload.size

            val framed = InterleavedFramer.frame(setup.dataChannel, packet) ?: return@submit
            synchronized(congestion) { congestion.offered(framed.size) }
            sendLock.withLock {
                sendQueue.enqueueSound(framed, capture, AudioEncoder.samplesPerFrame.toDouble() / frame.sampleRate, clock())
                sendReady.signalAll()
            }
            if (audioReports.reportIsDue(System.currentTimeMillis())) sendAudioReport(setup, timestamp, capture)
        }
    }

    /** This client's link since the last call, or null when it is not playing. */
    fun congestionSample(now: Double): CongestionSample? {
        val (dropped, flushes, waiting) = sendLock.withLock {
            Triple(sendQueue.droppedFrames, sendQueue.flushes, sendQueue.oldestWait(clock()))
        }
        val sample = synchronized(congestion) {
            congestion.sample(now, dropped, flushes, socketQueue?.queuedBytes(), waiting)
        }
        return if (isStreaming) sample else null
    }

    /**
     * A sender report about once a second, which is what RFC 3550 §6.2 recommends and what clients
     * use to derive a wall clock and to learn the CNAME.
     */
    private fun sendVideoReport(
        setup: RTSPResponder.Setup,
        rtpTimestamp: Long,
        captureTime: Double
    ) {
        // Stamped from the frame's capture time, not from the clock at send.
        //
        // The RTP timestamp in this report is derived from capture; pairing it with the wall clock
        // *here* makes the pair wrong by however long encode and the send queue took, and that is
        // variable — the queue backs up under contention — so it lands in the receiver's offset
        // estimate as noise it cannot filter out. It also makes any send-side delay invisible: hold
        // the frames and the report slides with them, so the receiver absorbs the fault and the
        // injection silently passes.
        val captureWallMillis = (captureTime * 1000).toLong() + captureToWallOffsetMillis

        val writer = RTCPWriter(videoSSRC, identity())
        val report = writer.compoundPacket(
            ntpTime = RTCPWriter.ntpTime(captureWallMillis),
            rtpTimestamp = rtpTimestamp,
            packetCount = videoPacketCount,
            octetCount = videoOctetCount
        )
        InterleavedFramer.frame(setup.controlChannel, report)?.let { write(it) }
    }

    /**
     * The audio stream's own sender report, about once a second, on the audio control channel.
     *
     * Without one a receiver has nothing tying the audio's RTP timeline to a wall clock, only to the
     * moment its first packet happened to arrive, and nothing downstream can tell when the sample
     * count behind those timestamps fell behind real time. Paired from the frame's capture time and
     * put on wall time through the same offset as the video's, so both streams share one mapping.
     */
    private fun sendAudioReport(
        setup: RTSPResponder.Setup,
        rtpTimestamp: Long,
        captureTime: Double
    ) {
        val captureWallMillis = (captureTime * 1000).toLong() + captureToWallOffsetMillis
        val writer = RTCPWriter(audioSSRC, identity())
        val report = writer.compoundPacket(
            ntpTime = RTCPWriter.ntpTime(captureWallMillis),
            rtpTimestamp = rtpTimestamp,
            packetCount = audioPacketCount,
            octetCount = audioOctetCount
        )
        InterleavedFramer.frame(setup.controlChannel, report)?.let { write(it) }
    }

    /** What waits for this client and what has been dropped, for the HUD and the state dump. */
    fun sendQueueSnapshot(): MediaSendQueue.Snapshot = sendLock.withLock { sendQueue.snapshot() }

    private companion object {
        /** How soon a writer that found no room looks again: the kernel drains between writes too. */
        const val retryMillis = 5L
    }
}
