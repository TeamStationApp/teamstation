package app.teamstation.streamcore.rtmp

import java.io.DataInputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/**
 * An RTMP ingest that speaks the subset a publisher needs: the handshake, `connect`,
 * `createStream` and `publish`, answering each the way node-media-server does, and recording what
 * arrives. [behaviour] makes it refuse, go quiet, or hang up, for the failure paths.
 */
class FakeRtmpServer(private val behaviour: Behaviour = Behaviour.ACCEPT) : AutoCloseable {
    enum class Behaviour {
        ACCEPT,

        /** `_error` in answer to `connect`. */
        REJECT_CONNECT,

        /** `onStatus` NetStream.Publish.BadName after the publish. */
        BAD_NAME,

        /** Accepts the TCP connection and never answers the handshake. */
        SILENT,

        /** Hangs up once the handshake is done. */
        HANG_UP,

        /** Holds S2 back until C2 has arrived, as nginx-rtmp does, and sends it with what follows. */
        LATE_S2
    }

    private val server = ServerSocket(0, 4, InetAddress.getLoopbackAddress())
    val port: Int get() = server.localPort
    val url: String get() = "rtmp://127.0.0.1:$port/live/00000000-0000-4000-8000-000000000001"
    val messages: MutableList<RTMPMessage> = Collections.synchronizedList(mutableListOf())
    val published = CountDownLatch(1)
    val closed = CountDownLatch(1)
    private val sockets = Collections.synchronizedList(mutableListOf<Socket>())

    @Volatile
    var pingAfterPublish = false

    init {
        thread(name = "fake-rtmp", isDaemon = true) {
            while (!server.isClosed) {
                val socket = runCatching { server.accept() }.getOrNull() ?: break
                sockets += socket
                thread(name = "fake-rtmp-conn", isDaemon = true) { serve(socket) }
            }
        }
    }

    fun awaitPublished(seconds: Long = 10) = published.await(seconds, TimeUnit.SECONDS)

    fun messages(type: RTMPMessageType): List<RTMPMessage> = synchronized(messages) { messages.filter { it.type == type } }

    /** Drops every connection, as an ingest that went away does. */
    fun dropConnections() {
        synchronized(sockets) { sockets.forEach { runCatching { it.close() } } }
    }

    override fun close() {
        runCatching { server.close() }
        dropConnections()
    }

    private fun serve(socket: Socket) {
        try {
            val input = DataInputStream(socket.getInputStream())
            val output = socket.getOutputStream()
            val c0c1 = ByteArray(1 + RTMPHandshake.packetSize)
            input.readFully(c0c1)
            if (behaviour == Behaviour.SILENT) {
                while (input.read() >= 0) Unit
                return
            }
            val s1 = ByteArray(RTMPHandshake.packetSize) { (it * 7).toByte() }
            val s2 = c0c1.copyOfRange(1, c0c1.size)
            output.write(byteArrayOf(3) + s1)
            if (behaviour != Behaviour.LATE_S2) output.write(s2)
            output.flush()
            val c2 = ByteArray(RTMPHandshake.packetSize)
            input.readFully(c2)
            if (behaviour == Behaviour.HANG_UP) return
            // A chunk size of our own, as servers send before answering; behind S2 in one write for
            // a server that held S2 back until it had C2.
            val setChunkSize = RTMPChunk.encode(RTMPMessage(0, RTMPMessageType.SET_CHUNK_SIZE, 0, byteArrayOf(0, 0, 0x10, 0)), 2, 128)
            synchronized(output) {
                output.write(if (behaviour == Behaviour.LATE_S2) s2 + setChunkSize else setChunkSize)
                output.flush()
            }
            val chunk = 4096
            val reader = RTMPChunkReader()
            val buffer = ByteArray(65536)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                for (message in reader.push(buffer.copyOf(count))) {
                    messages += message
                    if (message.type != RTMPMessageType.AMF0_COMMAND) continue
                    val values = AMF0.decodeList(message.payload)
                    val name = values.firstOrNull()?.stringValue
                    val tx = values.getOrNull(1)?.numberValue ?: 0.0
                    val answer: List<AMF0>? = when (name) {
                        "connect" -> if (behaviour == Behaviour.REJECT_CONNECT) {
                            listOf(
                                AMF0.Str("_error"), AMF0.Number(tx), AMF0.Null,
                                AMF0.Object(mapOf("description" to AMF0.Str("no such application")))
                            )
                        } else {
                            listOf(
                                AMF0.Str("_result"), AMF0.Number(tx), AMF0.Null,
                                AMF0.Object(mapOf("code" to AMF0.Str("NetConnection.Connect.Success")))
                            )
                        }
                        "createStream" -> listOf(AMF0.Str("_result"), AMF0.Number(tx), AMF0.Null, AMF0.Number(1.0))
                        "publish" -> listOf(
                            AMF0.Str("onStatus"), AMF0.Number(0.0), AMF0.Null,
                            AMF0.Object(
                                mapOf(
                                    "code" to AMF0.Str(
                                        if (behaviour == Behaviour.BAD_NAME) "NetStream.Publish.BadName" else "NetStream.Publish.Start"
                                    )
                                )
                            )
                        )
                        else -> null
                    }
                    if (answer != null) write(output, RTMPMessage(0, RTMPMessageType.AMF0_COMMAND, 0, AMF0.encode(answer)), 3, chunk)
                    if (name == "publish") {
                        if (pingAfterPublish) {
                            val ping = byteArrayOf(0, 6, 0, 0, 0, 42)
                            write(output, RTMPMessage(0, RTMPMessageType.USER_CONTROL, 0, ping), 2, chunk)
                        }
                        published.countDown()
                    }
                }
            }
        } catch (_: Exception) {
            // The test closed it.
        } finally {
            runCatching { socket.close() }
            closed.countDown()
        }
    }

    private fun write(output: OutputStream, message: RTMPMessage, stream: Int, chunk: Int) {
        synchronized(output) {
            output.write(RTMPChunk.encode(message, stream, chunk))
            output.flush()
        }
    }
}
