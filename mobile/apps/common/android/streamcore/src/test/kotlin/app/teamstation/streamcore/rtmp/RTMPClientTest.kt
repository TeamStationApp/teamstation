package app.teamstation.streamcore.rtmp

import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.StandardSocketOptions
import java.net.UnknownHostException
import java.nio.ByteBuffer
import java.nio.channels.ServerSocketChannel
import java.nio.channels.SocketChannel
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** [RTMPClient] against an in-process ingest, and its send path against a peer that stops reading. */
class RTMPClientTest {
    private val closers = mutableListOf<AutoCloseable>()

    @After
    fun tearDown() {
        closers.reversed().forEach { runCatching { it.close() } }
    }

    private fun server(behaviour: FakeRtmpServer.Behaviour = FakeRtmpServer.Behaviour.ACCEPT) =
        FakeRtmpServer(behaviour).also { closers += it }

    private fun client(codec: RTMPVideoCodec = RTMPVideoCodec.HEVC) = RTMPClient().apply {
        configure(sendBudgetBytes = 1_000_000, videoCodec = codec)
        closers += AutoCloseable { stop() }
    }

    private fun waitFor(seconds: Double = 5.0, condition: () -> Boolean) {
        val deadline = System.nanoTime() + (seconds * 1e9).toLong()
        while (!condition()) {
            if (System.nanoTime() > deadline) fail("timed out")
            Thread.sleep(10)
        }
    }

    private fun publishFailure(client: RTMPClient, url: String, timeout: Double = 5.0): RTMPClientError =
        try {
            runBlocking { client.publish(RTMPURL.require(url), timeout) }
            throw AssertionError("publish succeeded")
        } catch (error: RTMPClientError) {
            error
        }

    @Test
    fun aPublishGoesLiveAndCarriesTheStream() {
        val server = server()
        server.pingAfterPublish = true
        val client = client()
        assertEquals(RTMPClient.SendOutcome.NOT_LIVE, client.sendVideo(0, byteArrayOf(0x17, 0)))
        runBlocking { client.publish(RTMPURL.require(server.url)) }
        assertTrue(client.isLive)
        assertTrue(server.awaitPublished())

        client.sendMetadata(1920, 1080, 30, 4_000_000)
        val header = FLVTag.videoSequenceHeader(RTMPVideoCodec.HEVC, byteArrayOf(1, 2, 3))
        assertEquals(RTMPClient.SendOutcome.SENT, client.sendVideo(0, header))
        val picture = FLVTag.videoFrame(RTMPVideoCodec.HEVC, true, ByteArray(10_000) { it.toByte() })
        assertEquals(RTMPClient.SendOutcome.SENT, client.sendVideo(33, picture))
        client.sendAudio(21, FLVTag.audio(0, byteArrayOf(0x11, 0x90.toByte())))
        client.sendAudio(42, FLVTag.audio(1, ByteArray(300)))

        waitFor { server.messages(RTMPMessageType.VIDEO).size == 2 && server.messages(RTMPMessageType.AUDIO).size == 2 }
        val video = server.messages(RTMPMessageType.VIDEO)
        assertEquals(header.toList(), video[0].payload.toList())
        assertEquals(picture.toList(), video[1].payload.toList())
        assertEquals(33L, video[1].timestamp)
        assertEquals(1L, video[1].streamID)
        val metadata = server.messages(RTMPMessageType.AMF0_DATA).single()
        assertEquals("onMetaData", AMF0.decodeList(metadata.payload)[1].stringValue)
        // The connect named hvc1 in its fourCcList.
        val connect = AMF0.decodeList(server.messages(RTMPMessageType.AMF0_COMMAND).first().payload)
        assertEquals(
            AMF0.StrictArray(listOf(AMF0.Str("hvc1"))),
            connect[2].objectValue!!["fourCcList"]
        )
        // The ping was answered.
        waitFor { server.messages(RTMPMessageType.USER_CONTROL).isNotEmpty() }
        val pong = server.messages(RTMPMessageType.USER_CONTROL).single().payload
        assertEquals(listOf<Byte>(0, 7, 0, 0, 0, 42), pong.toList())

        waitFor { client.metrics.queuedBytes == 0 }
        val sample = client.congestionSample()
        assertTrue(sample.deliveredBytes > 10_000)
        assertTrue(sample.offeredBytes >= header.size + picture.size)
        assertNull(sample.transportBacklogBytes)
        assertEquals(0, sample.droppedFrames)
        assertTrue(client.bytesSentForTesting > 10_000)

        val already = publishFailure(client, server.url)
        assertEquals(RTMPClientError.ConnectFailed("already started"), already)
    }

    @Test
    fun aServerThatSendsS2LateStillGetsThePublish() {
        val server = server(FakeRtmpServer.Behaviour.LATE_S2)
        val client = client(RTMPVideoCodec.H264)
        runBlocking { client.publish(RTMPURL.require(server.url)) }
        assertTrue(client.isLive)
        val connect = AMF0.decodeList(server.messages(RTMPMessageType.AMF0_COMMAND).first().payload)
        assertNull(connect[2].objectValue!!["fourCcList"])
    }

    @Test
    fun aRefusedConnectNamesTheCodec() {
        val error = publishFailure(client(), server(FakeRtmpServer.Behaviour.REJECT_CONNECT).url)
        assertTrue(error is RTMPClientError.Rejected)
        assertTrue(error.description, error.description.startsWith("no such application — the server may not accept H.265"))
        val plain = publishFailure(client(RTMPVideoCodec.H264), server(FakeRtmpServer.Behaviour.REJECT_CONNECT).url)
        assertEquals(RTMPClientError.Rejected("no such application"), plain)
    }

    @Test
    fun aRefusedPublishEndsTheLiveStream() {
        val server = server(FakeRtmpServer.Behaviour.BAD_NAME)
        val client = client(RTMPVideoCodec.H264)
        val failure = AtomicReference<RTMPClientError>()
        val told = CountDownLatch(1)
        client.onFailure {
            failure.set(it)
            told.countDown()
        }
        runBlocking { client.publish(RTMPURL.require(server.url)) }
        assertTrue(told.await(5, TimeUnit.SECONDS))
        assertEquals(RTMPClientError.Rejected("NetStream.Publish.BadName"), failure.get())
        assertFalse(client.isLive)
    }

    @Test
    fun aSilentServerTimesOutWithTheHandshakeTrace() {
        val error = publishFailure(client(), server(FakeRtmpServer.Behaviour.SILENT).url, timeout = 0.5)
        assertTrue(error.description, error.description.contains("handshake timeout peer=127.0.0.1:"))
    }

    @Test
    fun aServerThatHangsUpWhileConnectingIsDisconnected() {
        val error = publishFailure(client(RTMPVideoCodec.H264), server(FakeRtmpServer.Behaviour.HANG_UP).url)
        // Either the read sees the close first or the C2 write does, as on iOS.
        assertTrue(error.description, error is RTMPClientError.Disconnected)
    }

    @Test
    fun aClosedPortAndAnUnknownHostFailToConnect() {
        val port = ServerSocket(0).use { it.localPort }
        val refused = publishFailure(client(), "rtmp://127.0.0.1:$port/live/key")
        assertEquals(RTMPClientError.ConnectFailed("could not open a TCP connection to the stream server"), refused)
        val unknown = RTMPClient { host, _, _ -> throw UnknownHostException(host) }
        closers += AutoCloseable { unknown.stop() }
        assertEquals(
            RTMPClientError.ConnectFailed("could not resolve nowhere.example.test"),
            publishFailure(unknown, "rtmp://nowhere.example.test/live/key")
        )
        assertEquals(
            RTMPClientError.ConnectFailed("invalid port 70000"),
            publishFailure(client(), "rtmp://127.0.0.1:70000/live/key")
        )
    }

    @Test
    fun aDropAfterGoingLiveIsReportedAndAStopIsNot() {
        val server = server()
        val client = client()
        val failure = AtomicReference<RTMPClientError>()
        val told = CountDownLatch(1)
        client.onFailure {
            failure.set(it)
            told.countDown()
        }
        runBlocking { client.publish(RTMPURL.require(server.url)) }
        server.dropConnections()
        assertTrue(told.await(5, TimeUnit.SECONDS))
        val error = failure.get()
        assertTrue(error.description, error is RTMPClientError.Disconnected)
        assertTrue(error.description.contains("the server may not accept H.265"))

        val quiet = client()
        val second = server()
        var reported = false
        quiet.onFailure { reported = true }
        runBlocking { quiet.publish(RTMPURL.require(second.url)) }
        quiet.stop()
        waitFor { !quiet.isLive }
        Thread.sleep(100)
        assertFalse(reported)
    }

    @Test
    fun aStopWhileConnectingCancelsThePublish() {
        val server = server(FakeRtmpServer.Behaviour.SILENT)
        val client = client()
        val thrown = AtomicReference<Throwable>()
        val done = CountDownLatch(1)
        Thread {
            try {
                runBlocking { client.publish(RTMPURL.require(server.url), 10.0) }
            } catch (error: Throwable) {
                thrown.set(error)
            }
            done.countDown()
        }.start()
        Thread.sleep(300)
        client.stop()
        assertTrue(done.await(5, TimeUnit.SECONDS))
        assertEquals(RTMPClientError.Cancelled, thrown.get())
    }

    /** A connected pair of channels whose receiving end does not read until told to. */
    private class StalledPeer : AutoCloseable {
        val listener: ServerSocketChannel = ServerSocketChannel.open().apply {
            // Small windows, set before the connection exists so they are the ones it negotiates.
            setOption(StandardSocketOptions.SO_RCVBUF, 8 * 1024)
            bind(InetSocketAddress(InetAddress.getLoopbackAddress(), 0))
        }
        val sender: SocketChannel = SocketChannel.open().apply {
            setOption(StandardSocketOptions.SO_SNDBUF, 8 * 1024)
            connect(listener.localAddress)
        }
        val receiver: SocketChannel = listener.accept()
        @Volatile
        var received = 0L

        fun drain() {
            Thread {
                val buffer = ByteBuffer.allocate(64 * 1024)
                while (true) {
                    buffer.clear()
                    val count = runCatching { receiver.read(buffer) }.getOrDefault(-1)
                    if (count < 0) break
                    received += count
                }
            }.apply { isDaemon = true }.start()
        }

        override fun close() {
            runCatching { receiver.close() }
            runCatching { sender.close() }
            runCatching { listener.close() }
        }
    }

    private fun groups(client: RTMPClient, count: Int, frameBytes: Int) {
        client.sendVideo(0, FLVTag.videoSequenceHeader(RTMPVideoCodec.HEVC, ByteArray(40)))
        for (group in 0 until count) {
            for (frame in 0 until 30) {
                val tag = FLVTag.videoFrame(RTMPVideoCodec.HEVC, frame == 0, ByteArray(if (frame == 0) frameBytes * 4 else frameBytes))
                client.sendVideo((group * 30L + frame) * 33, tag)
                if (frame % 3 == 0) client.sendAudio((group * 30L + frame) * 33, FLVTag.audio(1, ByteArray(400)))
            }
        }
    }

    @Test
    fun aSendTimeoutIsBackpressureAndTheBacklogStaysWithinBudget() {
        val peer = StalledPeer().also { closers += it }
        val transport = ChannelRTMPTransport.wrap(peer.sender, sendTimeoutSeconds = 0.05)
        val client = RTMPClient()
        closers += AutoCloseable { client.stop() }
        val budget = RTMPClient.minimumSendBudgetBytes
        client.attachForTesting(transport, budgetBytes = budget, stallDeadlineSeconds = 3.0)
        var failed: RTMPClientError? = null
        client.onFailure { failed = it }

        // Ten groups of 2 KB pictures, about 1.5 MB, into a peer that is not reading.
        groups(client, count = 10, frameBytes = 4_000)
        Thread.sleep(500)
        val metrics = client.metrics
        assertTrue("queued ${metrics.queuedBytes}", metrics.queuedBytes <= budget)
        assertTrue(metrics.droppedPackets > 0)
        assertTrue(client.firstQueuedVideoIsKeyframeForTesting)
        assertTrue(client.isLive)
        assertNull(failed)
        val sample = client.congestionSample()
        assertTrue(sample.queueDelay > 0.3)

        // The link comes back within the deadline: everything still queued goes, and nothing failed.
        peer.drain()
        waitFor { client.metrics.queuedBytes == 0 }
        assertTrue(client.isLive)
        assertNull(failed)
        assertEquals(client.bytesSentForTesting, waitForReceived(peer, client.bytesSentForTesting))
    }

    private fun waitForReceived(peer: StalledPeer, expected: Long): Long {
        waitFor { peer.received >= expected }
        return peer.received
    }

    @Test
    fun aPeerThatTakesNothingForTheDeadlineIsGone() {
        val peer = StalledPeer().also { closers += it }
        val transport = ChannelRTMPTransport.wrap(peer.sender, sendTimeoutSeconds = 0.05)
        val client = RTMPClient()
        closers += AutoCloseable { client.stop() }
        client.attachForTesting(transport, budgetBytes = 4_000_000, stallDeadlineSeconds = 0.4)
        val failure = AtomicReference<RTMPClientError>()
        val told = CountDownLatch(1)
        client.onFailure {
            failure.set(it)
            told.countDown()
        }
        groups(client, count = 4, frameBytes = 8_000)
        assertTrue(told.await(5, TimeUnit.SECONDS))
        assertEquals(RTMPClientError.Disconnected("stream server stopped accepting data"), failure.get())
        assertFalse(client.isLive)
        assertEquals(0, client.metrics.queuedBytes)
    }

    @Test
    fun closingTheTransportWhileItWaitsToReadOrWriteEndsItQuietly() {
        // The client's stop closes the transport from another thread while its read thread waits on
        // the selector: that read ends the stream (-1), and a write in the same wait reads as a closed
        // socket, never an unchecked ClosedSelectorException that kills the app.
        repeat(20) {
            val peer = StalledPeer().also { closers += it }
            val transport = ChannelRTMPTransport.wrap(peer.sender, sendTimeoutSeconds = 5.0)
            val read = AtomicReference<Any>()
            val reader = Thread {
                read.set(runCatching { transport.receive(ByteArray(16)) }.fold({ it }, { it }))
            }.also { it.start() }
            Thread.sleep(20)
            transport.close()
            reader.join(2_000)
            assertEquals(-1, read.get())
        }
        val peer = StalledPeer().also { closers += it }
        val transport = ChannelRTMPTransport.wrap(peer.sender, sendTimeoutSeconds = 5.0)
        val written = AtomicReference<Any>()
        val writer = Thread {
            val big = ByteArray(1 shl 20)
            written.set(runCatching { while (true) transport.send(big, 0, big.size) }.exceptionOrNull())
        }.also { it.start() }
        Thread.sleep(200)
        transport.close()
        writer.join(2_000)
        assertTrue("${written.get()}", written.get() is java.io.IOException)
    }

    @Test
    fun aQueueOlderThanTheBufferShedsAllButHeaders() {
        val peer = StalledPeer().also { closers += it }
        val transport = ChannelRTMPTransport.wrap(peer.sender, sendTimeoutSeconds = 0.05)
        val client = RTMPClient()
        closers += AutoCloseable { client.stop() }
        client.attachForTesting(transport, budgetBytes = 64 * 1024 * 1024, bufferSeconds = 0.2, stallDeadlineSeconds = 10.0)
        groups(client, count = 6, frameBytes = 4_000)
        Thread.sleep(400)
        // One more write finds the oldest waiting past the buffer, and everything but headers goes.
        client.sendAudio(10_000, FLVTag.audio(1, ByteArray(10)))
        assertTrue(client.metrics.droppedPackets > 100)
        assertTrue(client.firstQueuedVideoIsKeyframeForTesting)
    }

    @Test
    fun theOperatorsMessagesNameTheLikelyCause() {
        val hint = "the server may not accept H.265 over Enhanced RTMP; choose H.264 in Settings"
        assertEquals(
            RTMPClientError.Disconnected("reset — $hint"),
            RTMPClient.explainingCodecRefusal(RTMPClientError.Disconnected("reset"), RTMPVideoCodec.HEVC, 2.0)
        )
        assertEquals(
            RTMPClientError.Disconnected("reset"),
            RTMPClient.explainingCodecRefusal(RTMPClientError.Disconnected("reset"), RTMPVideoCodec.HEVC, 60.0)
        )
        assertEquals(
            RTMPClientError.Timeout,
            RTMPClient.explainingCodecRefusal(RTMPClientError.Timeout, RTMPVideoCodec.HEVC, null)
        )
        assertEquals("stream server did not answer in time", RTMPClientError.Timeout.description)
        assertEquals("streaming stopped", RTMPClientError.Cancelled.description)
        assertEquals("server closed the socket", RTMPClient.serverClosedReason(true, " t20/10"))
        assertEquals("server closed the socket t20/10", RTMPClient.serverClosedReason(false, " t20/10"))
        assertEquals(512 * 1024, RTMPClient.sendBudget(1))
        assertEquals(64 * 1024 * 1024, RTMPClient.sendBudget(1_000_000_000))
        assertNotNull(RTMPClient.adaptiveBitrateTuning)
    }
}
