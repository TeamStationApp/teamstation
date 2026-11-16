package app.teamstation.app.network

import androidx.test.ext.junit.runners.AndroidJUnit4
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On the phone's own kernel, the networking socket's `TCP_USER_TIMEOUT` is
 * set and honoured, and a plain socket's is not. The peer here accepts and
 * never reads, so once its window is full the socket's bytes stop being
 * taken and the kernel's zero-window probes go on: Linux ends those at the
 * user timeout from 5.11 (the Pixel 10 runs 6.6). A stalled link's resends
 * end at the same timeout; that path is shown on the phone by
 * `offlineDevice.e2e.ts` step 8.
 */
@RunWith(AndroidJUnit4::class)
class StalledConnectionsDeviceTest {
    /** Writes to `socket` until a write fails, and answers how long that took, or null within `limitMs`. */
    private fun closedAfterMs(socket: Socket, limitMs: Long): Long? {
        ServerSocket().use { server ->
            server.receiveBufferSize = 4096
            server.bind(InetSocketAddress(InetAddress.getLoopbackAddress(), 0))
            socket.sendBufferSize = 4096
            socket.connect(InetSocketAddress(InetAddress.getLoopbackAddress(), server.localPort), 5_000)
            server.accept().use {
                val started = System.nanoTime()
                var failedAt: Long? = null
                // Set before the test's own close: a write that fails after it
                // is the close's, not the kernel's.
                val closing = AtomicBoolean(false)
                val writer =
                    Thread {
                        val chunk = ByteArray(16 * 1024)
                        try {
                            while (true) socket.getOutputStream().write(chunk)
                        } catch (_: IOException) {
                            if (!closing.get()) failedAt = (System.nanoTime() - started) / 1_000_000
                        }
                    }
                writer.start()
                writer.join(limitMs)
                closing.set(true)
                socket.close()
                writer.join()
                return failedAt
            }
        }
    }

    @Test
    fun aNetworkingSocketIsClosedAtItsUserTimeout() {
        val closed = closedAfterMs(StalledConnections.socketFactory.createSocket(), 45_000)
        assertNotNull("never closed", closed)
        assertTrue("closed after $closed ms", closed!! >= StalledConnections.USER_TIMEOUT_MS - 1_000)
    }

    @Test
    fun aPlainSocketIsNot() {
        assertNull(closedAfterMs(Socket(), StalledConnections.USER_TIMEOUT_MS + 10_000L))
    }
}
