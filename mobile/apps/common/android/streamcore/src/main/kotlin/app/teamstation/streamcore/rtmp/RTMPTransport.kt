package app.teamstation.streamcore.rtmp

import java.io.FileDescriptor
import java.io.IOException
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.nio.ByteBuffer
import java.nio.channels.ClosedSelectorException
import java.nio.channels.SelectionKey
import java.nio.channels.Selector
import java.nio.channels.SocketChannel

/**
 * Thrown by [RTMPTransport.send] when the socket took nothing within its send timeout: TS Director's
 * `EAGAIN` from a blocking socket with `SO_SNDTIMEO`. It is backpressure, not a dead peer.
 */
class RTMPWouldBlockException : IOException("send timed out (EAGAIN)")

/** The TCP connection under an [RTMPClient]: a socket whose writes give up after a send timeout. */
interface RTMPTransport {
    /** `host:port` of the peer, for the handshake trace. */
    val peerDescription: String

    /**
     * Writes some of `length` bytes from [offset], answering how many the socket took. Throws
     * [RTMPWouldBlockException] when it took none within the send timeout, and an [IOException] when
     * the connection is broken.
     */
    fun send(data: ByteArray, offset: Int, length: Int): Int

    /** Reads into [buffer], answering how many bytes arrived, or -1 once the peer has closed. */
    fun receive(buffer: ByteArray): Int

    /** Wakes a blocked send or receive; both fail or end from here on. */
    fun shutdown()

    fun close()

    /** Bytes the kernel holds that the peer has not acknowledged, or null when it cannot say. */
    fun unsentBytes(): Int?
}

/**
 * [RTMPTransport] on a `SocketChannel`. Writes are non-blocking and wait for room on a selector for at
 * most [sendTimeoutSeconds], which is `SO_SNDTIMEO` on TS Director's blocking socket: a write that
 * makes no progress in that time throws [RTMPWouldBlockException].
 */
class ChannelRTMPTransport private constructor(
    private val channel: SocketChannel,
    @Volatile var sendTimeoutSeconds: Double
) : RTMPTransport {
    private val readSelector: Selector = Selector.open()
    private val writeSelector: Selector = Selector.open()
    private val descriptor: FileDescriptor? = TransportBacklog.descriptor(channel)

    init {
        channel.configureBlocking(false)
        channel.register(readSelector, SelectionKey.OP_READ)
        channel.register(writeSelector, SelectionKey.OP_WRITE)
    }

    override val peerDescription: String =
        (channel.remoteAddress as? InetSocketAddress)?.let { "${it.address.hostAddress}:${it.port}" } ?: ""

    override fun send(data: ByteArray, offset: Int, length: Int): Int {
        val buffer = ByteBuffer.wrap(data, offset, length)
        val deadline = System.nanoTime() + (sendTimeoutSeconds * 1e9).toLong()
        while (true) {
            val written = channel.write(buffer)
            if (written > 0) return written
            val remaining = (deadline - System.nanoTime()) / 1_000_000
            if (remaining <= 0) throw RTMPWouldBlockException()
            try {
                writeSelector.select(remaining)
                writeSelector.selectedKeys().clear()
            } catch (closed: ClosedSelectorException) {
                // [close] on another thread: the socket is gone, as a closed channel would say.
                throw IOException("socket closed")
            }
            if (!channel.isOpen) throw IOException("socket closed")
        }
    }

    override fun receive(buffer: ByteArray): Int {
        val wrapped = ByteBuffer.wrap(buffer)
        while (true) {
            val count = channel.read(wrapped)
            if (count != 0) return count
            try {
                readSelector.select()
                readSelector.selectedKeys().clear()
            } catch (closed: ClosedSelectorException) {
                // [close] from the client's stop, while this thread waited to read: the end of the
                // stream, not a crash of the read thread.
                return -1
            }
            if (!channel.isOpen) return -1
        }
    }

    override fun shutdown() {
        runCatching { channel.shutdownInput() }
        runCatching { channel.shutdownOutput() }
        readSelector.wakeup()
        writeSelector.wakeup()
    }

    override fun close() {
        shutdown()
        runCatching { channel.close() }
        runCatching { readSelector.close() }
        runCatching { writeSelector.close() }
    }

    override fun unsentBytes(): Int? = descriptor?.let { TransportBacklog.unsentBytes(it) }

    companion object {
        /**
         * Connects to [host] on [port] over IPv4 where the host has an IPv4 address, as TS Director
         * does, with `TCP_NODELAY` set.
         */
        fun connect(host: String, port: Int, sendTimeoutSeconds: Double, connectTimeoutSeconds: Double = 20.0): ChannelRTMPTransport {
            val addresses = InetAddress.getAllByName(host)
            val address = addresses.firstOrNull { it is Inet4Address } ?: addresses.first()
            val channel = SocketChannel.open()
            try {
                channel.socket().tcpNoDelay = true
                channel.socket().connect(InetSocketAddress(address, port), (connectTimeoutSeconds * 1000).toInt())
                return ChannelRTMPTransport(channel, sendTimeoutSeconds)
            } catch (error: IOException) {
                runCatching { channel.close() }
                throw error
            }
        }

        /** Wraps a channel that is already connected, for tests that hold the other end. */
        internal fun wrap(channel: SocketChannel, sendTimeoutSeconds: Double): ChannelRTMPTransport =
            ChannelRTMPTransport(channel, sendTimeoutSeconds)
    }
}

/**
 * The kernel's unsent bytes on a socket, `SIOCOUTQ`: TS Director reads `SO_NWRITE` for the same
 * number. Android exposes neither the socket's descriptor nor `ioctl` publicly, so both are reached
 * by reflection, and anywhere they cannot be (a JVM, or a release that refuses the call) the answer
 * is null, which the bitrate controller reads as "the transport cannot say".
 */
internal object TransportBacklog {
    /** `SIOCOUTQ`, the same request number as `TIOCOUTQ` on Linux. */
    private const val SIOCOUTQ = 0x5411

    fun descriptor(channel: SocketChannel): FileDescriptor? = runCatching {
        val method = channel.javaClass.getMethod("getFD")
        method.isAccessible = true
        method.invoke(channel) as? FileDescriptor
    }.getOrNull()

    fun unsentBytes(descriptor: FileDescriptor): Int? = runCatching {
        val os = Class.forName("android.system.Os")
        val ioctl = os.getMethod("ioctlInt", FileDescriptor::class.java, Int::class.javaPrimitiveType)
        maxOf(0, ioctl.invoke(null, descriptor, SIOCOUTQ) as Int)
    }.getOrNull()
}
