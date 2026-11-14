package app.teamstation.app.network

import android.os.ParcelFileDescriptor
import android.system.Os
import android.system.OsConstants
import android.util.Log
import com.facebook.react.modules.network.CustomClientBuilder
import com.facebook.react.modules.network.NetworkingModule
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketAddress
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.SocketFactory
import okhttp3.OkHttpClient

/**
 * Lets the app's requests leave a connection that has stopped answering.
 *
 * Every `fetch` shares one HTTP/2 connection to TeamStation. On a link that
 * stalls (a phone at the edge of a field's Wi-Fi) each segment on it goes
 * unanswered, and the phone backs off resending up to two minutes between
 * tries. Once the link comes back nothing moves on that connection until its
 * next try, and OkHttp keeps putting every new request on it: the queue's
 * writes waited up to two minutes after the signal returned. A request that
 * misses its deadline (`REQUEST_DEADLINE_MS` in `src/common/api.ts`) only
 * stops waiting for its answer; the connection stays.
 *
 * Each socket of React Native's networking client (`fetch` and XHR) is given
 * `TCP_USER_TIMEOUT`: the kernel closes it once bytes it sent have gone
 * unacknowledged for `USER_TIMEOUT_MS`, and the next request opens a new
 * connection, which a link that came back answers at once. Only a link that
 * has stopped acknowledging is closed: a slow upload is acknowledged as it
 * goes however slow it is, a request the server takes long to answer has
 * nothing unacknowledged, and an idle connection sends nothing. A connect is
 * given up after `CONNECT_TIMEOUT_MS`.
 *
 * What it does not cover:
 * - Only the phone's own bytes start the timer. A stall that catches the
 *   server's answer on its way, while the phone sends nothing until the link
 *   is back, leaves the server's resend backoff to deliver it; a write the
 *   phone made during the stall closes the connection as above.
 * - A server that stops reading a request body (a zero window) for
 *   `USER_TIMEOUT_MS` closes that connection too; TeamStation reads a body
 *   as it arrives.
 * - An upload, which keeps no deadline, used to carry on over a drop longer
 *   than `USER_TIMEOUT_MS` once the link came back; it now fails with the
 *   connection, as do the other requests on it, and is sent again by its
 *   caller (a chat attachment's part is sent again harmlessly).
 * - It owns React Native's one custom client builder slot: a library that
 *   installs its own later replaces it. `react-native-worklets`' networking
 *   keeps a client of its own, which goes without it, as do WebSockets, video
 *   and the other libraries' clients.
 */
object StalledConnections {
    private const val TAG = "StalledConnections"

    /**
     * How long bytes sent on a connection may go unacknowledged before it is
     * closed: twice the request deadline, so a slow answer is the request's to
     * give up on, and a link that drops for a few seconds (a roam between
     * access points) keeps its connection.
     */
    const val USER_TIMEOUT_MS = 20_000

    /** A new connection's TCP connect: the request deadline, as React Native's own WebSocket uses. */
    const val CONNECT_TIMEOUT_MS = 10_000L

    /** Linux's `TCP_USER_TIMEOUT` (`include/uapi/linux/tcp.h`), which `OsConstants` does not name. */
    const val TCP_USER_TIMEOUT = 18

    private val warned = AtomicBoolean(false)

    /** Whether a socket has gone without the timeout since the app started. */
    internal val hasWarned: Boolean
        get() = warned.get()

    /** Gives a connected socket `TCP_USER_TIMEOUT`, through a duplicate of its descriptor. */
    internal fun setUserTimeout(socket: Socket) {
        val descriptor = ParcelFileDescriptor.fromSocket(socket) ?: error("the socket has no descriptor")
        descriptor.use {
            Os.setsockoptInt(it.fileDescriptor, OsConstants.IPPROTO_TCP, TCP_USER_TIMEOUT, USER_TIMEOUT_MS)
        }
    }

    /** Said once: every connection then goes without the timeout, as before. */
    private fun warn(error: Exception) {
        if (!warned.compareAndSet(false, true)) return
        try {
            Log.w(TAG, "TCP_USER_TIMEOUT not set; stalled connections stay until TCP resends", error)
        } catch (_: RuntimeException) {
            // A log that cannot be written (a JVM test's stub) changes nothing.
        }
    }

    /** One for every request: OkHttp's pool is shared by the requests' clients. */
    val socketFactory = UserTimeoutSocketFactory(::setUserTimeout, ::warn)

    private val clientBuilder = CustomClientBuilder { builder -> configure(builder) }

    /** The networking client's builder, its sockets given the user timeout and a connect bounded. */
    fun configure(builder: OkHttpClient.Builder, factory: SocketFactory = socketFactory): OkHttpClient.Builder =
        builder
            .socketFactory(factory)
            .connectTimeout(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)

    /** Every request React Native's networking sends after this is sent by such a client. */
    fun register(install: (CustomClientBuilder) -> Unit = NetworkingModule::setCustomClientBuilder) {
        install(clientBuilder)
    }

    /**
     * Plain sockets that are given the user timeout once connected. A socket
     * the option cannot be set on is used as it is (`failed` is told): the
     * connection works, as it did before, and only goes without the timeout.
     */
    class UserTimeoutSocketFactory(
        private val userTimeout: (Socket) -> Unit,
        private val failed: (Exception) -> Unit = {},
    ) : SocketFactory() {
        override fun createSocket(): Socket = UserTimeoutSocket(userTimeout, failed)

        // OkHttp only creates unconnected sockets and connects them itself;
        // these are the factory's contract for any other caller.
        override fun createSocket(host: String, port: Int): Socket = connected(InetSocketAddress(host, port), null)

        override fun createSocket(host: String, port: Int, localHost: InetAddress, localPort: Int): Socket =
            connected(InetSocketAddress(host, port), InetSocketAddress(localHost, localPort))

        override fun createSocket(host: InetAddress, port: Int): Socket = connected(InetSocketAddress(host, port), null)

        override fun createSocket(address: InetAddress, port: Int, localAddress: InetAddress, localPort: Int): Socket =
            connected(InetSocketAddress(address, port), InetSocketAddress(localAddress, localPort))

        private fun connected(remote: InetSocketAddress, local: InetSocketAddress?): Socket =
            createSocket().apply {
                if (local != null) bind(local)
                connect(remote)
            }
    }

    private class UserTimeoutSocket(
        private val userTimeout: (Socket) -> Unit,
        private val failed: (Exception) -> Unit,
    ) : Socket() {
        override fun connect(endpoint: SocketAddress, timeout: Int) {
            super.connect(endpoint, timeout)
            try {
                userTimeout(this)
            } catch (error: Exception) {
                failed(error)
            }
        }
    }
}
