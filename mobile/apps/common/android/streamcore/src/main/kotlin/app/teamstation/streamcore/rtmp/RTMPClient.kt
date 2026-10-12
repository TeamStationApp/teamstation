package app.teamstation.streamcore.rtmp

import app.teamstation.streamcore.bitrate.AdaptiveBitrateController
import app.teamstation.streamcore.bitrate.CongestionSample
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.IOException
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.thread
import kotlin.concurrent.withLock
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Why a publish failed or ended. A port of TS Director's `RTMPClientError`. */
sealed class RTMPClientError(val description: String) : Exception(description) {
    data object Cancelled : RTMPClientError("streaming stopped")

    data object Timeout : RTMPClientError("stream server did not answer in time")

    data class ConnectFailed(val reason: String) : RTMPClientError("could not connect to stream server: $reason")
    data class Rejected(val reason: String) : RTMPClientError(reason)
    data class Disconnected(val reason: String) : RTMPClientError("stream disconnected: $reason")
}

/**
 * Publishes H.264 (classic FLV) or H.265 (Enhanced RTMP) video and AAC audio over RTMP. A port of TS
 * Director's `RTMPClient`.
 *
 * Metrics count bytes that left the socket and tags that did not, which is the OBS "dropped frames
 * (network)" number rather than TCP retransmits.
 *
 * Every write is counted and queued here, under the lock, at the moment it is submitted, and a single
 * sender on [queue] hands the queue to the socket. A socket that falls behind therefore leaves a
 * backlog this class can see and bound: [shedOldestLocked] throws whole oldest groups away once it
 * holds more than the send budget or [sendBufferSeconds] of waiting. A write that the socket takes
 * nothing of for its send timeout is backpressure ([RTMPWouldBlockException], `EAGAIN` on the iOS
 * socket); only one that makes no progress for [stallDeadlineSeconds] declares the peer gone.
 */
class RTMPClient(
    /** Opens the connection. Replaced in tests. */
    private val connector: (host: String, port: Int, sendTimeoutSeconds: Double) -> RTMPTransport =
        { host, port, timeout -> ChannelRTMPTransport.connect(host, port, timeout) }
) {
    data class Metrics(
        val megabitsPerSecond: Double = 0.0,
        val droppedPackets: Long = 0,
        /**
         * Bytes handed to the sender that have not reached the socket. Pinned at the budget is the
         * signature of an upstream stall.
         */
        val queuedBytes: Int = 0
    )

    /** What [sendVideo] / [sendAudio] did with a tag. */
    enum class SendOutcome {
        SENT,

        /** Shed because the socket is behind. The stream is still live. */
        DROPPED_OVER_BUDGET,

        /** Shed because video resumes on the next keyframe. The encoder should force an IDR. */
        DROPPED_AWAITING_KEYFRAME,

        /** Not publishing. Nothing was sent and nothing was queued. */
        NOT_LIVE
    }

    private enum class Phase { IDLE, HANDSHAKING, CONNECTED, CREATING_STREAM, PUBLISHING, LIVE, FAILED }

    /** One whole RTMP message waiting for the socket, with what the shed policy needs to judge it. */
    private class Queued(
        val data: ByteArray,
        val submittedAt: Double,
        val isVideo: Boolean,
        val isKeyframe: Boolean,
        val isSequenceHeader: Boolean
    )

    /** One waiting message, as the shed policy sees it. */
    data class ShedItem(
        val bytes: Int,
        val isVideo: Boolean,
        val isKeyframe: Boolean,
        val isSequenceHeader: Boolean
    )

    private val queue = ScheduledThreadPoolExecutor(1) { runnable ->
        Thread(runnable, "rtmp").apply {
            isDaemon = true
            queueThread = this
        }
    }.apply { executeExistingDelayedTasksAfterShutdownPolicy = false }

    @Volatile
    private var queueThread: Thread? = null
    private val lock = ReentrantLock()
    private var transport: RTMPTransport? = null
    private var reader = RTMPChunkReader()
    private var handshakeBuffer = ByteArray(0)
    private var phase = Phase.IDLE
    private var outChunkSize = RTMPChunk.defaultSize
    private var streamID = 0L
    private var bytesSent = 0L
    private var bytesThisWindow = 0L
    private var windowStarted = monotonicNow()
    private var megabitsPerSecond = 0.0
    private var droppedPackets = 0L
    private val sendQueue = ArrayDeque<Queued>()
    private var isSending = false

    /**
     * Bytes written but not yet on the wire, wherever they are parked: incremented where the work is
     * submitted and decremented where it completes.
     */
    private var queuedBytes = 0
    private var ledger = RTMPSendLedger()
    private var sendBudgetBytes = defaultSendBudgetBytes
    private var bufferSeconds = sendBufferSeconds
    private var sendTimeoutSeconds = 2.0
    private var stallDeadline = stallDeadlineSeconds
    private var videoCodec = RTMPVideoCodec.H264
    private var liveSince = 0.0

    /** True from [stop] onward, so the error a teardown provokes reports as cancellation. */
    private var isStopping = false
    private var connectWait: CancellableContinuation<Unit>? = null
    private var onFailure: ((RTMPClientError) -> Unit)? = null
    private var url: RTMPURL? = null
    private var socketReady = false
    private var sentC2 = false
    private var handshakePeer = ""
    private var handshakeSent = 0
    private var handshakeRecv = 0
    private var handshakeTrace = StringBuilder()

    val metrics: Metrics
        get() = lock.withLock {
            refreshMegabitsLocked()
            Metrics(megabitsPerSecond, droppedPackets, queuedBytes)
        }

    val isLive: Boolean get() = lock.withLock { phase == Phase.LIVE }

    /**
     * How many bytes may sit between [sendVideo]/[sendAudio] and the socket, and how long the oldest
     * of them may wait, before media is shed; how long a single write may block before it counts as
     * backpressure; and which codec the video tags carry. Call before [publish].
     */
    fun configure(
        sendBudgetBytes: Int,
        bufferSeconds: Double = sendBufferSeconds,
        sendTimeoutSeconds: Double = 2.0,
        videoCodec: RTMPVideoCodec = RTMPVideoCodec.H264
    ) {
        lock.withLock {
            this.sendBudgetBytes = maxOf(sendBudgetBytes, minimumSendBudgetBytes)
            this.bufferSeconds = maxOf(bufferSeconds, 0.1)
            this.sendTimeoutSeconds = maxOf(sendTimeoutSeconds, 0.1)
            this.videoCodec = videoCodec
        }
    }

    /**
     * What the link did since the previous call, in video's terms, for the bitrate controller: the
     * age of the oldest write the socket has not taken, the bytes it took and the media bytes offered,
     * the kernel's unsent bytes, and the packets the budget shed.
     */
    fun congestionSample(now: Double = monotonicNow()): CongestionSample {
        val current = lock.withLock { transport }
        val backlog = current?.unsentBytes()
        return lock.withLock { ledger.sample(now, droppedPackets, backlog) }
    }

    /** Connects, handshakes, and publishes [url]; returns once the publish is live. */
    suspend fun publish(url: RTMPURL, timeoutSeconds: Double = 20.0) {
        suspendCancellableCoroutine { continuation ->
            post {
                begin(url, continuation)
                schedule(timeoutSeconds) { publishTimedOut() }
            }
        }
    }

    private fun publishTimedOut() {
        val (waiting, ready, trace) = lock.withLock {
            Triple(
                connectWait != null && phase != Phase.LIVE,
                socketReady,
                "handshake timeout peer=$handshakePeer sent=$handshakeSent recv=$handshakeRecv$handshakeTrace"
            )
        }
        if (!waiting) return
        fail(
            RTMPClientError.ConnectFailed(
                if (ready) trace else "could not open a TCP connection to the stream server"
            ),
            notifyWaiter = true
        )
    }

    fun stop() {
        // Wake anything parked in a send before the queued teardown runs; otherwise the stop waits
        // out a whole send timeout behind a blocked write on a stalled peer.
        val current = lock.withLock {
            isStopping = true
            transport
        }
        current?.shutdown()
        post {
            fail(RTMPClientError.Cancelled, notifyWaiter = true)
            queue.shutdown()
        }
    }

    fun onFailure(handler: (RTMPClientError) -> Unit) {
        lock.withLock { onFailure = handler }
    }

    fun sendVideo(timestampMs: Long, tag: ByteArray): SendOutcome =
        enqueueMedia(RTMPMessageType.VIDEO, videoChunk, timestampMs, tag, isVideo = true)

    fun sendAudio(timestampMs: Long, tag: ByteArray): SendOutcome =
        enqueueMedia(RTMPMessageType.AUDIO, audioChunk, timestampMs, tag, isVideo = false)

    fun sendMetadata(width: Int, height: Int, frameRate: Int, bitrate: Int) {
        post {
            val (stream, live, codec) = lock.withLock { Triple(streamID, phase == Phase.LIVE, videoCodec) }
            if (!live) return@post
            val payload = metadataPayload(width, height, frameRate, bitrate, codec)
            write(
                RTMPChunk.encode(
                    RTMPMessage(stream, RTMPMessageType.AMF0_DATA, 0, payload),
                    dataChunk,
                    outChunkSize
                )
            )
        }
    }

    private fun begin(url: RTMPURL, continuation: CancellableContinuation<Unit>) {
        val started = lock.withLock {
            if (phase != Phase.IDLE) return@withLock false
            connectWait = continuation
            this.url = url
            phase = Phase.HANDSHAKING
            handshakeBuffer = ByteArray(0)
            reader = RTMPChunkReader()
            socketReady = false
            isStopping = false
            sentC2 = false
            handshakePeer = ""
            handshakeSent = 0
            handshakeRecv = 0
            handshakeTrace = StringBuilder()
            true
        }
        if (!started) {
            continuation.resumeWithException(RTMPClientError.ConnectFailed("already started"))
            return
        }
        if (url.port !in 0..65535) {
            fail(RTMPClientError.ConnectFailed("invalid port ${url.port}"), notifyWaiter = true)
            return
        }
        val timeout = lock.withLock { sendTimeoutSeconds }
        thread(name = "rtmp-io", isDaemon = true) { connectAndRead(url, timeout) }
    }

    /** Connects, sends C0 and C1, and then reads until the connection ends: TS Director's `ioQueue`. */
    private fun connectAndRead(url: RTMPURL, sendTimeout: Double) {
        val connected = try {
            connector(url.host, url.port, sendTimeout)
        } catch (error: Exception) {
            val reason = if (error is java.net.UnknownHostException) {
                "could not resolve ${url.host}"
            } else {
                "could not open a TCP connection to the stream server"
            }
            post { fail(RTMPClientError.ConnectFailed(reason), notifyWaiter = true) }
            return
        }
        val accepted = lock.withLock {
            if (phase == Phase.FAILED || isStopping) return@withLock false
            transport = connected
            socketReady = true
            true
        }
        if (!accepted) {
            connected.close()
            return
        }
        val hello = RTMPHandshake.c0c1()
        var sent = 0
        try {
            while (sent < hello.size) sent += connected.send(hello, sent, hello.size - sent)
        } catch (error: IOException) {
            post { fail(RTMPClientError.ConnectFailed("could not send the stream handshake"), notifyWaiter = true) }
            return
        }
        lock.withLock {
            handshakePeer = connected.peerDescription
            handshakeSent = sent
        }
        val buffer = ByteArray(64 * 1024)
        while (true) {
            val count = try {
                connected.receive(buffer)
            } catch (error: IOException) {
                post { fail(RTMPClientError.Disconnected("socket read failed (${error.message})"), notifyWaiter = true) }
                return
            }
            if (count > 0) {
                val chunk = buffer.copyOf(count)
                post {
                    lock.withLock { handshakeRecv += count }
                    handle(chunk)
                }
                continue
            }
            post {
                val reason = lock.withLock { serverClosedReason(phase == Phase.LIVE, handshakeTrace.toString()) }
                fail(RTMPClientError.Disconnected(reason), notifyWaiter = true)
            }
            return
        }
    }

    private fun handle(data: ByteArray) {
        if (lock.withLock { phase } == Phase.HANDSHAKING) {
            handshakeBuffer += data
            // nginx-rtmp often withholds S2 until it has C2, so C2 goes as soon as S1 is in.
            val s0s1 = 1 + RTMPHandshake.packetSize
            if (!sentC2 && handshakeBuffer.size >= s0s1) {
                sentC2 = true
                write(RTMPHandshake.c2(handshakeBuffer.copyOfRange(1, s0s1)))
            }
            if (RTMPHandshake.splitServerHello(handshakeBuffer) == null) return
            val consumed = 1 + RTMPHandshake.packetSize * 2
            val leftover = handshakeBuffer.copyOfRange(consumed, handshakeBuffer.size)
            handshakeBuffer = ByteArray(0)
            sendConnect()
            if (leftover.isNotEmpty()) {
                lock.withLock { handshakeTrace.append(" leftover=${leftover.size}") }
                val messages = reader.push(leftover)
                lock.withLock { handshakeTrace.append(" parsed=${messages.size}") }
                messages.forEach { handle(it) }
            }
            return
        }
        reader.push(data).forEach { handle(it) }
    }

    private fun handle(message: RTMPMessage) {
        lock.withLock { handshakeTrace.append(" t${message.type.rawValue}/${message.payload.size}") }
        when (message.type) {
            RTMPMessageType.SET_CHUNK_SIZE -> if (message.payload.size >= 4) {
                val size = readUInt32BE(message.payload)
                if (size in 1..Int.MAX_VALUE) reader.setChunkSize(size.toInt())
            }
            RTMPMessageType.USER_CONTROL -> if (message.payload.size >= 6) {
                val event = ((message.payload[0].toInt() and 0xFF) shl 8) or (message.payload[1].toInt() and 0xFF)
                if (event == 6) {
                    val pong = byteArrayOf(0x00, 0x07) + message.payload.copyOfRange(2, message.payload.size)
                    write(
                        RTMPChunk.encode(
                            RTMPMessage(0, RTMPMessageType.USER_CONTROL, 0, pong),
                            controlChunk,
                            outChunkSize
                        )
                    )
                }
            }
            RTMPMessageType.AMF0_COMMAND, RTMPMessageType.AMF3_COMMAND -> handleCommand(message.payload)
            else -> Unit
        }
    }

    private fun handleCommand(payload: ByteArray) {
        val values = AMF0.decodeList(payload)
        val tx = values.getOrNull(1)?.numberValue?.toInt() ?: 0
        val name = values.firstOrNull()?.stringValue
        if (name == null) {
            lock.withLock { handshakeTrace.append(" amf0empty") }
            return
        }
        lock.withLock { handshakeTrace.append(" $name#$tx") }
        when (name) {
            "_result" -> {
                val current = lock.withLock { phase }
                if (current == Phase.CONNECTED && tx == 1) {
                    sendCreateStream()
                } else if (current == Phase.CREATING_STREAM) {
                    val stream = values.getOrNull(3)?.numberValue?.toLong() ?: 1L
                    sendPublish(stream)
                }
            }
            "_error" -> {
                val detail = values.firstNotNullOfOrNull { it.objectValue }?.get("description")?.stringValue
                    ?: "stream server rejected the publish"
                fail(RTMPClientError.Rejected(detail), notifyWaiter = true)
            }
            "onStatus" -> {
                val code = values.firstNotNullOfOrNull { it.objectValue }?.get("code")?.stringValue ?: ""
                lock.withLock { handshakeTrace.append(" $code") }
                if (code.contains("Publish.Start")) {
                    markLive()
                } else if (code.contains("Publish.BadName") || code.contains("Failed") || code.contains("Rejected")) {
                    fail(RTMPClientError.Rejected(code), notifyWaiter = true)
                }
            }
        }
    }

    private fun sendConnect() {
        val target = url ?: return
        outChunkSize = 4096
        write(
            RTMPChunk.encode(
                RTMPMessage(0, RTMPMessageType.SET_CHUNK_SIZE, 0, uint32BE(outChunkSize.toLong())),
                controlChunk,
                RTMPChunk.defaultSize
            )
        )
        write(
            RTMPChunk.encode(
                RTMPMessage(0, RTMPMessageType.WINDOW_ACK_SIZE, 0, uint32BE(2_500_000)),
                controlChunk,
                outChunkSize
            )
        )
        val codec = lock.withLock { videoCodec }
        write(
            RTMPChunk.encode(
                RTMPMessage(0, RTMPMessageType.AMF0_COMMAND, 0, connectPayload(target, codec)),
                commandChunk,
                outChunkSize
            )
        )
        lock.withLock { phase = Phase.CONNECTED }
    }

    private fun sendCreateStream() {
        lock.withLock { phase = Phase.CREATING_STREAM }
        val payload = AMF0.encode(listOf(AMF0.Str("createStream"), AMF0.Number(2.0), AMF0.Null))
        write(
            RTMPChunk.encode(
                RTMPMessage(0, RTMPMessageType.AMF0_COMMAND, 0, payload),
                commandChunk,
                outChunkSize
            )
        )
    }

    private fun sendPublish(stream: Long) {
        val target = url ?: return
        lock.withLock {
            streamID = stream
            phase = Phase.PUBLISHING
        }
        write(
            RTMPChunk.encode(
                RTMPMessage(stream, RTMPMessageType.AMF0_COMMAND, 0, publishPayload(target.stream)),
                commandChunk,
                outChunkSize
            )
        )
        markLive()
    }

    private fun markLive() {
        val waiter = lock.withLock {
            if (phase != Phase.LIVE && phase != Phase.FAILED) {
                phase = Phase.LIVE
                liveSince = monotonicNow()
            }
            val waiting = connectWait
            connectWait = null
            waiting
        }
        waiter?.resume(Unit)
    }

    /**
     * Frames a media tag and submits it. Sequence headers are never shed; see [shedIndices] for
     * what is.
     */
    private fun enqueueMedia(
        type: RTMPMessageType,
        chunkStreamID: Int,
        timestamp: Long,
        payload: ByteArray,
        isVideo: Boolean
    ): SendOutcome {
        val (stream, chunkSize) = lock.withLock {
            if (phase != Phase.LIVE) return SendOutcome.NOT_LIVE
            ledger.offered(payload.size, isAudio = !isVideo)
            streamID to outChunkSize
        }
        val isSequenceHeader =
            if (isVideo) FLVTag.isVideoSequenceHeader(payload) else FLVTag.isAudioSequenceHeader(payload)
        val isKeyframe = isVideo && FLVTag.isVideoKeyframe(payload)
        write(
            RTMPChunk.encode(RTMPMessage(stream, type, timestamp, payload), chunkStreamID, chunkSize),
            isVideo = isVideo,
            isKeyframe = isKeyframe,
            isSequenceHeader = isSequenceHeader
        )
        return SendOutcome.SENT
    }

    /**
     * Throws the oldest waiting messages away until the queue fits the budget again: the oldest, so
     * the viewer jumps forward and stays near live. Whole groups go, so what is left starts on a
     * keyframe. Called with the lock held.
     */
    private fun shedOldestLocked() {
        val now = monotonicNow()
        val dropped = shedIndices(
            sendQueue.map { ShedItem(it.data.size, it.isVideo, it.isKeyframe, it.isSequenceHeader) },
            queuedBytes = queuedBytes,
            budget = sendBudgetBytes,
            delayExceeded = ledger.queueDelay(now) > bufferSeconds
        )
        if (dropped.isEmpty()) return
        for (index in dropped) queuedBytes = maxOf(0, queuedBytes - sendQueue[index].data.size)
        val gone = dropped.toHashSet()
        val kept = sendQueue.filterIndexed { index, _ -> index !in gone }
        sendQueue.clear()
        sendQueue.addAll(kept)
        droppedPackets += dropped.size
        ledger.resetWaiting(sendQueue.map { it.data.size }, sendQueue.map { it.submittedAt })
    }

    /** Whether the first picture still queued is one the ingest can decode on its own. */
    internal val firstQueuedVideoIsKeyframeForTesting: Boolean
        get() = lock.withLock {
            sendQueue.firstOrNull { it.isVideo && !it.isSequenceHeader }?.isKeyframe ?: true
        }

    /** Control writes (handshake, acknowledgements, the publish itself) are never shed. */
    private fun write(data: ByteArray) = write(data, isVideo = false, isKeyframe = false, isSequenceHeader = true)

    private fun write(data: ByteArray, isVideo: Boolean, isKeyframe: Boolean, isSequenceHeader: Boolean) {
        if (data.isEmpty()) return
        // Counted here, at submission: a write that only reached a queue behind a blocked sender
        // could not otherwise be seen, or shed.
        val now = monotonicNow()
        val sending = lock.withLock {
            if (phase == Phase.FAILED) {
                queuedBytes = 0
                ledger.clear()
                return
            }
            queuedBytes += data.size
            ledger.submitted(data.size, now)
            sendQueue.addLast(Queued(data, now, isVideo, isKeyframe, isSequenceHeader))
            shedOldestLocked()
            val already = isSending
            if (!already) isSending = true
            already
        }
        if (sending) return
        if (Thread.currentThread() === queueThread) flush() else post { flush() }
    }

    private fun flush() {
        while (true) {
            val (data, current) = lock.withLock {
                if (sendQueue.isEmpty()) {
                    isSending = false
                    return
                }
                sendQueue.removeFirst().data to transport
            }
            if (current == null) {
                release(data.size)
                fail(RTMPClientError.Disconnected("socket closed"), notifyWaiter = true)
                return
            }
            val failure = send(data, current)
            release(data.size)
            if (failure != null) {
                fail(failure, notifyWaiter = true)
                return
            }
        }
    }

    /**
     * Writes every byte of one message. A send timeout ([RTMPWouldBlockException]) is a link carrying
     * less than the programme, not a peer that has gone, and the queue behind it is being shed
     * meanwhile; only [stallDeadline] seconds without any progress counts the peer as gone. Returns
     * the error to fail with, or null once the message is gone.
     */
    private fun send(data: ByteArray, over: RTMPTransport): RTMPClientError? {
        val (peerLabel, stallSeconds) = lock.withLock {
            (url?.let { "${it.host}:${it.port}" } ?: "stream server") to stallDeadline
        }
        var offset = 0
        var noProgressSince: Double? = null
        while (offset < data.size) {
            val sent = try {
                over.send(data, offset, data.size - offset)
            } catch (blocked: RTMPWouldBlockException) {
                val now = monotonicNow()
                val since = noProgressSince ?: now
                noProgressSince = since
                if (now - since >= stallSeconds) return RTMPClientError.Disconnected("$peerLabel stopped accepting data")
                continue
            } catch (error: IOException) {
                return RTMPClientError.Disconnected("socket write failed (${error.message})")
            }
            offset += sent
            noProgressSince = null
            account(sent)
        }
        return null
    }

    private fun account(sent: Int) {
        lock.withLock {
            bytesSent += sent
            bytesThisWindow += sent
            ledger.delivered(sent)
            refreshMegabitsLocked()
        }
    }

    private fun release(count: Int) {
        lock.withLock { queuedBytes = maxOf(0, queuedBytes - count) }
    }

    private fun refreshMegabitsLocked() {
        val elapsed = monotonicNow() - windowStarted
        if (elapsed >= 1) {
            megabitsPerSecond = StreamMetrics.megabits(bytesThisWindow, elapsed)
            bytesThisWindow = 0
            windowStarted = monotonicNow()
        }
    }

    private fun fail(error: RTMPClientError, notifyWaiter: Boolean) {
        var reported: RTMPClientError = error
        var wasLive = false
        var waiter: CancellableContinuation<Unit>? = null
        var handler: ((RTMPClientError) -> Unit)? = null
        var current: RTMPTransport? = null
        lock.withLock {
            if (phase == Phase.FAILED) return
            wasLive = phase == Phase.LIVE
            // Whichever path arrives first after `stop`, a deliberate teardown reports as
            // cancellation: the socket error it provokes is our own doing.
            reported = if (isStopping) {
                RTMPClientError.Cancelled
            } else {
                explainingCodecRefusal(error, videoCodec, if (wasLive) monotonicNow() - liveSince else null)
            }
            phase = Phase.FAILED
            waiter = if (notifyWaiter) connectWait else null
            connectWait = null
            handler = onFailure
            current = transport
            transport = null
            sendQueue.clear()
            isSending = false
            queuedBytes = 0
            ledger.clear()
        }
        current?.close()
        waiter?.resumeWithException(reported)
        if (wasLive && reported != RTMPClientError.Cancelled) handler?.invoke(reported)
    }

    private fun post(work: () -> Unit) {
        try {
            queue.execute(work)
        } catch (_: RejectedExecutionException) {
            // Stopped: the work is for a client that is gone.
        }
    }

    private fun schedule(seconds: Double, work: () -> Unit) {
        try {
            queue.schedule(work, (seconds * 1000).toLong(), TimeUnit.MILLISECONDS)
        } catch (_: RejectedExecutionException) {
            // Stopped.
        }
    }

    /**
     * Drives the send path over a caller-supplied transport, so a test can stall the peer without a
     * real RTMP server. Goes straight to live; no handshake is performed.
     */
    internal fun attachForTesting(
        transport: RTMPTransport,
        budgetBytes: Int,
        bufferSeconds: Double = sendBufferSeconds,
        stallDeadlineSeconds: Double = RTMPClient.stallDeadlineSeconds
    ) {
        lock.withLock {
            stallDeadline = maxOf(stallDeadlineSeconds, 0.0)
            this.transport = transport
            phase = Phase.LIVE
            streamID = 1
            sendBudgetBytes = budgetBytes
            this.bufferSeconds = bufferSeconds
            queuedBytes = 0
            ledger = RTMPSendLedger()
            droppedPackets = 0
        }
    }

    internal val bytesSentForTesting: Long get() = lock.withLock { bytesSent }

    companion object {
        /**
         * How long the stream may wait for the link before it sheds anything. A platform's player
         * sits 5–20 s behind, so a dip in the link is better sent late than dropped.
         */
        const val sendBufferSeconds = 30.0

        /** How long one write may make no progress at all before the peer counts as gone. */
        const val stallDeadlineSeconds = 45.0

        /** What a client holds before [configure] gives it a budget of its own. */
        internal const val defaultSendBudgetBytes = 1_500_000
        internal const val minimumSendBudgetBytes = 512 * 1024
        internal const val maximumSendBudgetBytes = 64 * 1024 * 1024

        /**
         * How long after going live a hang-up still reads as the server refusing the codec. Much
         * later than that it is the network.
         */
        internal const val codecRefusalWindowSeconds = 10.0

        private const val controlChunk = 2
        private const val commandChunk = 3
        private const val dataChunk = 4
        private const val audioChunk = 8
        private const val videoChunk = 9

        /**
         * The send buffer's size in bytes: [sendBufferSeconds] of the high bitrate, with room for the
         * encoder's one-second spikes to half again the rate, kept between 512 KB and 64 MB.
         */
        fun sendBudget(forBitrate: Int): Int {
            val bytes = (forBitrate.toDouble() / 8 * sendBufferSeconds * 1.5).toLong()
            return bytes.coerceIn(minimumSendBudgetBytes.toLong(), maximumSendBudgetBytes.toLong()).toInt()
        }

        /** The bitrate controller's tuning for an RTMP stream. */
        val adaptiveBitrateTuning: AdaptiveBitrateController.Tuning = AdaptiveBitrateController.Tuning.rtmpStream

        /** Seconds on a clock that does not jump, which the ledger stamps writes with. */
        fun monotonicNow(): Double = System.nanoTime() / 1e9

        /**
         * Which waiting messages to throw away, oldest first, by their place in [queue].
         *
         * While the queue holds more than [budget] bytes, or its oldest has waited longer than the
         * send buffer ([delayExceeded]), the oldest message that is not a sequence header goes. Then,
         * if anything went, the pictures at the front that are not keyframes go too, so the queue
         * starts on one the ingest can decode.
         */
        fun shedIndices(queue: List<ShedItem>, queuedBytes: Int, budget: Int, delayExceeded: Boolean): List<Int> {
            var bytes = queuedBytes
            val remaining = queue.indices.toMutableList()
            val dropped = mutableListOf<Int>()
            fun overBudget() = bytes > budget || delayExceeded
            if (!overBudget()) return emptyList()
            while (overBudget()) {
                val position = remaining.indexOfFirst { !queue[it].isSequenceHeader }
                if (position < 0) break
                bytes = maxOf(0, bytes - queue[remaining[position]].bytes)
                dropped += remaining.removeAt(position)
            }
            if (dropped.isEmpty()) return emptyList()
            while (true) {
                val position = remaining.indexOfFirst { queue[it].isVideo && !queue[it].isSequenceHeader }
                if (position < 0 || queue[remaining[position]].isKeyframe) break
                dropped += remaining.removeAt(position)
            }
            return dropped
        }

        /** `@setDataFrame onMetaData`. `videocodecid` is 7 for H.264, and the FourCC for H.265. */
        fun metadataPayload(width: Int, height: Int, frameRate: Int, bitrate: Int, codec: RTMPVideoCodec): ByteArray =
            AMF0.encode(
                listOf(
                    AMF0.Str("@setDataFrame"),
                    AMF0.Str("onMetaData"),
                    AMF0.EcmaArray(
                        mapOf(
                            "duration" to AMF0.Number(0.0),
                            "width" to AMF0.Number(width.toDouble()),
                            "height" to AMF0.Number(height.toDouble()),
                            "framerate" to AMF0.Number(frameRate.toDouble()),
                            "videodatarate" to AMF0.Number(bitrate.toDouble() / 1000),
                            "videocodecid" to AMF0.Number(codec.metadataCodecID),
                            "audiodatarate" to AMF0.Number(128.0),
                            "audiocodecid" to AMF0.Number(10.0),
                            "audiosamplerate" to AMF0.Number(48_000.0),
                            "audiochannels" to AMF0.Number(2.0),
                            "stereo" to AMF0.Bool(true)
                        )
                    )
                )
            )

        /** The `publish` command for a stream key, as a live stream. */
        fun publishPayload(stream: String): ByteArray =
            AMF0.encode(
                listOf(AMF0.Str("publish"), AMF0.Number(3.0), AMF0.Null, AMF0.Str(stream), AMF0.Str("live"))
            )

        /**
         * The `connect` command. An Enhanced RTMP codec is also named in `fourCcList`; classic H.264
         * leaves the object as every server has always seen it.
         */
        fun connectPayload(url: RTMPURL, codec: RTMPVideoCodec): ByteArray {
            val pairs = linkedMapOf<String, AMF0>(
                "app" to AMF0.Str(url.app),
                "flashVer" to AMF0.Str("FMLE/3.0 (compatible; FMSc/1.0)"),
                "tcUrl" to AMF0.Str(url.tcURL),
                "type" to AMF0.Str("nonprivate"),
                "audioCodecs" to AMF0.Number(1024.0),
                "videoCodecs" to AMF0.Number(128.0),
                "videoFunction" to AMF0.Number(1.0)
            )
            if (codec.isEnhanced) pairs["fourCcList"] = AMF0.StrictArray(listOf(AMF0.Str(codec.fourCCString)))
            return AMF0.encode(listOf(AMF0.Str("connect"), AMF0.Number(1.0), AMF0.Object(pairs)))
        }

        /**
         * The operator's message for a failure, with the likely cause added when an Enhanced RTMP
         * codec was refused or hung up on early.
         */
        fun explainingCodecRefusal(error: RTMPClientError, codec: RTMPVideoCodec, secondsLive: Double?): RTMPClientError {
            if (!codec.isEnhanced) return error
            if (secondsLive != null && secondsLive > codecRefusalWindowSeconds) return error
            val hint = "the server may not accept ${codec.displayName} over Enhanced RTMP; choose H.264 in Settings"
            return when (error) {
                is RTMPClientError.Rejected -> RTMPClientError.Rejected("${error.reason} — $hint")
                is RTMPClientError.Disconnected -> RTMPClientError.Disconnected("${error.reason} — $hint")
                else -> error
            }
        }

        /** Why the stream ended when the server hung up; the handshake trace only while connecting. */
        fun serverClosedReason(live: Boolean, handshakeTrace: String): String =
            "server closed the socket${if (live) "" else handshakeTrace}"

        private fun uint32BE(value: Long): ByteArray =
            byteArrayOf((value ushr 24).toByte(), (value ushr 16).toByte(), (value ushr 8).toByte(), value.toByte())

        private fun readUInt32BE(data: ByteArray): Long =
            if (data.size < 4) 0 else ((data[0].toLong() and 0xFF) shl 24) or ((data[1].toLong() and 0xFF) shl 16) or
                ((data[2].toLong() and 0xFF) shl 8) or (data[3].toLong() and 0xFF)
    }
}
