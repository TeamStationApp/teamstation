package app.teamstation.cameraman.rtsp

import android.os.ParcelFileDescriptor
import java.net.Socket

/**
 * How many bytes a TCP socket's kernel send queue is holding: written, and not yet acknowledged by
 * the peer.
 *
 * The writer is credited when `write` returns, which is when bytes reach the kernel, so without this
 * a congested link fills the kernel's buffer while this side sees nothing waiting at all. Measured on
 * the Pixel 10 on 2026-09-12: a probe past a 2.5 Mbit cap froze Director's picture for 3 s while the
 * app's own queue read empty. Android has no public API for it — `android.system.Os` offers only
 * `FIONREAD` — so it is one `ioctl(SIOCOUTQ)` in `socket_queue.c`.
 *
 * Holds a duplicate of the socket's descriptor, so it must be closed with the connection.
 */
internal class SocketQueue private constructor(private val descriptor: ParcelFileDescriptor) {
    /** Bytes the kernel holds for this socket, or null if it refused to say. */
    fun queuedBytes(): Int? = nativeQueuedBytes(descriptor.fd).takeIf { it >= 0 }

    fun close() {
        runCatching { descriptor.close() }
    }

    companion object {
        private val isLoaded = runCatching { System.loadLibrary("socketqueue") }.isSuccess

        @JvmStatic
        private external fun nativeQueuedBytes(fd: Int): Int

        /**
         * A reader for [socket], or null where there is none: no native library (a JVM unit test),
         * or a sandbox that refuses the call. Tried once here, so a refusal is known at accept.
         */
        fun open(socket: Socket): SocketQueue? {
            if (!isLoaded) return null
            val descriptor = runCatching { ParcelFileDescriptor.fromSocket(socket) }.getOrNull()
                ?: return null
            val queue = SocketQueue(descriptor)
            if (queue.queuedBytes() == null) {
                queue.close()
                return null
            }
            return queue
        }
    }
}
