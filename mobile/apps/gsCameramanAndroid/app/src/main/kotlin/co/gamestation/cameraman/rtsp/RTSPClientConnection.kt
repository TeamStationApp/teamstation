package co.gamestation.cameraman.rtsp

import co.gamestation.cameraman.core.DeviceIdentity
import co.gamestation.cameraman.core.EncodedAudioFrame
import co.gamestation.cameraman.core.EncodedVideoFrame
import co.gamestation.cameraman.core.StreamCodec
import java.io.OutputStream
import java.net.Socket
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.RejectedExecutionException
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
 * So the executor decides and frames, hands finished bytes to the writer, and the writer credits the
 * send queue once they have actually left. That is also what makes [StreamSendQueue] honest: bytes
 * are debited on enqueue and credited on completion, never on enqueue alone.
 */
internal class RTSPClientConnection(
    private val socket: Socket,
    private val sdp: (Long, Long) -> String,
    hasAudio: Boolean,
    private val identity: () -> DeviceIdentity,
    private val requestKeyframe: () -> Unit
) {
    private val queue: ExecutorService =
        Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "rtsp-conn") }
    private val writes = LinkedBlockingQueue<WriteItem>()
    private var writerThread: Thread? = null
    private var readerThread: Thread? = null
    private lateinit var output: OutputStream

    private var responder: RTSPResponder

    private var buffer = ByteArray(0)
    private var isStreaming = false
    private var isAwaitingKeyframe = false
    private var videoSetup: RTSPResponder.Setup? = null
    private var audioSetup: RTSPResponder.Setup? = null

    private val videoSSRC: Long = Random.nextLong(1, 0xFFFFFFFFL)
    private val audioSSRC: Long = Random.nextLong(1, 0xFFFFFFFFL)
    private var videoSequence = 0
    private var audioSequence = 0
    private var videoPacketCount = 0L
    private var videoOctetCount = 0L
    private var audioFrameIndex = 0
    private var firstVideoPresentationTime: Double? = null
    private var lastSentVideoTimestamp: Long? = null
    private var lastReportMillis = 0L

    val sendQueue = StreamSendQueue()
    private var closeReason = "cancelled"
    private var isClosed = false

    var onClose: ((String) -> Unit)? = null

    init {
        // Distinct SSRCs per connection, so two clients watching at once are separable in a capture.
        responder = RTSPResponder(
            sessionIdentifier = RTSPResponder.generateSessionIdentifier(),
            sdp = sdp(videoSSRC, audioSSRC),
            hasAudio = hasAudio
        )
    }

    private data class WriteItem(val bytes: ByteArray, val generation: Int?, val isMedia: Boolean)

    fun start() {
        // Nagle would hold a small RTSP response back waiting for more to coalesce with, which on a
        // request/response exchange is up to 40 ms of dead time per method.
        runCatching { socket.tcpNoDelay = true }
        // A client that vanished without a FIN would otherwise hold a thread and a send queue open
        // until the OS gave up, which on Wi-Fi is minutes.
        runCatching { socket.soTimeout = 0 }
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
     * TEARDOWN before the socket goes — queues [poisonPill] behind the response instead, so the
     * writer drains in order and the client gets its answer.
     */
    private fun shutdown() {
        if (isClosed) return
        isClosed = true
        writes.clear()
        // A poison pill rather than an interrupt: an interrupted write leaves the socket in an
        // indeterminate state, and this one is being closed anyway.
        writes.offer(poisonPill())
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
                hasAudio = responder.hasAudio
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
                lastSentVideoTimestamp = null
                audioFrameIndex = 0

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
                // The response goes out first and the pill behind it, because the writer drains in
                // order. Closing the socket here instead would discard the response, and the client
                // would then wait out its TEARDOWN timeout on a connection the server has already
                // forgotten. `writeLoop` calls `shutdown` once the pill comes round.
                write(outcome.response.wireFormat)
                writes.offer(poisonPill())
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
            "url=$base/${SDPBuilder.videoTrackControl};seq=$videoSequence;rtptime=0"
        )
        if (hasAudio) {
            tracks.add("url=$base/${SDPBuilder.audioTrackControl};seq=$audioSequence;rtptime=0")
        }
        return tracks.joinToString(",")
    }

    // MARK: - Writing

    private fun write(data: ByteArray) {
        if (isClosed || data.isEmpty()) return
        writes.offer(WriteItem(data, null, false))
    }

    private fun writeLoop() {
        try {
            while (true) {
                val item = writes.take()
                // Empty payload is the poison pill; there is no legitimate zero-byte write.
                if (item.bytes.isEmpty()) return
                output.write(item.bytes)
                output.flush()
                if (item.isMedia) {
                    val count = item.bytes.size
                    val generation = item.generation
                    // Credited on completion rather than enqueue, so the queue depth reflects what
                    // the client has actually taken.
                    submit { sendQueue.complete(count, generation) }
                }
            }
        } catch (error: Exception) {
            submit {
                if (!isClosed) {
                    closeReason = "send: ${error.message ?: error.javaClass.simpleName}"
                }
            }
        } finally {
            // However this thread ends — pill, broken pipe, closed socket — the connection is done.
            // `shutdown` is idempotent, so the read side racing to the same conclusion is harmless.
            submit { shutdown() }
        }
    }

    private fun poisonPill() = WriteItem(ByteArray(0), null, false)

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
            when (sendQueue.decide(bytes, frame.isKeyframe)) {
                StreamSendQueue.Decision.DROP -> return@submit
                StreamSendQueue.Decision.FLUSH_THEN_SEND ->
                    // `decide` bumped `generation`, so completions from the abandoned batches will
                    // not debit this keyframe. Unlike Network.framework, a queue of not-yet-written
                    // batches *can* be dropped outright, so the client also stops receiving stale
                    // pictures rather than only stopping being charged for them.
                    dropPendingMedia()
                StreamSendQueue.Decision.SEND -> Unit
            }

            if (firstVideoPresentationTime == null) firstVideoPresentationTime = frame.presentationTime
            val elapsed = frame.presentationTime - (firstVideoPresentationTime ?: frame.presentationTime)
            var timestamp = (elapsed * H264Packetizer.clockRate).toLong() and 0xFFFFFFFFL

            // A receiver treats a timestamp change as the end of a picture, so two frames sharing one
            // are merged into a single malformed access unit. The capture clock does occasionally
            // repeat a presentation time, so the sent timestamp is forced to advance.
            val last = lastSentVideoTimestamp
            if (last != null && timestamp <= last) {
                timestamp = (last + 1) and 0xFFFFFFFFL
            }
            lastSentVideoTimestamp = timestamp

            val writer = RTPPacketWriter(SDPBuilder.videoPayloadType, videoSSRC)
            val batch = ByteBuilder(bytes + payloads.size * 16)
            for ((index, payload) in payloads.withIndex()) {
                // The marker bit goes on the last packet of the picture, which is how the receiver
                // knows the frame is complete without waiting for the next timestamp.
                val packet = writer.packet(
                    sequenceNumber = videoSequence,
                    timestamp = timestamp,
                    marker = index == payloads.size - 1,
                    payload = payload
                )
                videoSequence = (videoSequence + 1) and 0xFFFF
                videoPacketCount += 1
                videoOctetCount += payload.size
                InterleavedFramer.frame(setup.dataChannel, packet)?.let { batch.bytes(it) }
            }

            sendMedia(batch.build())
            sendReportIfDue(setup, timestamp)
        }
    }

    fun send(frame: EncodedAudioFrame) {
        submit {
            val setup = audioSetup
            if (!isStreaming || setup == null || isClosed) return@submit
            val payload = AACPacketizer().payload(frame) ?: return@submit

            val writer = RTPPacketWriter(SDPBuilder.audioPayloadType, audioSSRC)
            val packet = writer.packet(
                sequenceNumber = audioSequence,
                timestamp = AACPacketizer.timestamp(audioFrameIndex),
                marker = true,
                payload = payload
            )
            audioSequence = (audioSequence + 1) and 0xFFFF
            audioFrameIndex += 1

            val framed = InterleavedFramer.frame(setup.dataChannel, packet) ?: return@submit
            sendQueue.enqueueAudio(framed.size)
            sendMedia(framed)
        }
    }

    private fun sendMedia(data: ByteArray) {
        if (data.isEmpty() || isClosed) return
        writes.offer(WriteItem(data, sendQueue.generation, true))
    }

    private fun dropPendingMedia() {
        val kept = ArrayList<WriteItem>()
        val drained = ArrayList<WriteItem>()
        writes.drainTo(drained)
        // RTSP responses queued behind media must still go out; only pictures are expendable.
        for (item in drained) if (!item.isMedia) kept.add(item)
        for (item in kept) writes.offer(item)
    }

    /**
     * A sender report about once a second, which is what RFC 3550 §6.2 recommends and what clients
     * use to derive a wall clock and to learn the CNAME.
     */
    private fun sendReportIfDue(setup: RTSPResponder.Setup, rtpTimestamp: Long) {
        val now = System.currentTimeMillis()
        if (now - lastReportMillis < 1000) return
        lastReportMillis = now

        val writer = RTCPWriter(videoSSRC, identity())
        val report = writer.compoundPacket(
            ntpTime = RTCPWriter.ntpTime(now),
            rtpTimestamp = rtpTimestamp,
            packetCount = videoPacketCount,
            octetCount = videoOctetCount
        )
        InterleavedFramer.frame(setup.controlChannel, report)?.let { write(it) }
    }
}
