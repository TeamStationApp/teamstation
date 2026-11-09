package app.teamstation.app.network

import com.facebook.react.modules.network.CustomClientBuilder
import com.facebook.react.modules.network.NetworkingModule
import com.facebook.react.modules.network.OkHttpClientProvider
import com.facebook.react.modules.network.ReactCookieJarContainer
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.file.Files
import okhttp3.Cache
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * Each socket of React Native's networking client is given the user timeout
 * once connected, and the client is otherwise React Native's. The kernel's
 * closing of a socket whose bytes go unacknowledged is Linux's own, and is
 * shown on the phone (`offlineDevice.e2e.ts`, step 8).
 */
class StalledConnectionsTest {
    private val server = MockWebServer()
    private val cacheDirectory: File = Files.createTempDirectory("http-cache").toFile()

    @Before
    fun start() {
        server.start()
    }

    @After
    fun stop() {
        server.shutdown()
        cacheDirectory.deleteRecursively()
        NetworkingModule.setCustomClientBuilder(null)
    }

    private fun get(client: OkHttpClient) {
        server.enqueue(MockResponse().setBody("ok"))
        client.newCall(Request.Builder().url(server.url("/")).build()).execute().use {
            assertEquals("ok", it.body!!.string())
        }
    }

    @Test
    fun givesEachConnectedSocketTheUserTimeout() {
        val given = mutableListOf<Socket>()
        val client =
            StalledConnections.configure(
                OkHttpClientProvider.createClientBuilder(),
                StalledConnections.UserTimeoutSocketFactory({ given += it }),
            ).build()
        get(client)
        assertEquals(1, given.size)
        assertTrue(given[0].isConnected)
        assertEquals(server.port, given[0].port)
        // The same connection carries the next request: no socket of its own.
        get(client)
        assertEquals(1, given.size)
    }

    @Test
    fun usesASocketTheTimeoutCannotBeSetOnAndSaysSo() {
        val failures = mutableListOf<Exception>()
        val factory =
            StalledConnections.UserTimeoutSocketFactory(
                { throw IllegalStateException("no TCP_USER_TIMEOUT here") },
                { failures += it },
            )
        get(StalledConnections.configure(OkHttpClientProvider.createClientBuilder(), factory).build())
        assertEquals(listOf("no TCP_USER_TIMEOUT here"), failures.map { it.message })
    }

    @Test
    fun theAppsOwnFactorySaysOnceWhenItCannotSetTheTimeout() {
        // `setUserTimeout` needs Android's `ParcelFileDescriptor` and `Os`,
        // which a JVM test has only as stubs: the socket is used without it.
        get(StalledConnections.configure(OkHttpClientProvider.createClientBuilder()).build())
        assertTrue(StalledConnections.hasWarned)
        get(StalledConnections.configure(OkHttpClientProvider.createClientBuilder()).build())
    }

    @Test
    fun connectsAndGivesTheTimeoutThroughEveryFactoryCall() {
        ServerSocket(0, 50, InetAddress.getLoopbackAddress()).use { server ->
            val given = mutableListOf<Socket>()
            val factory = StalledConnections.UserTimeoutSocketFactory({ given += it })
            val loopback = InetAddress.getLoopbackAddress()
            val sockets =
                listOf(
                    factory.createSocket(loopback.hostAddress!!, server.localPort),
                    factory.createSocket(loopback.hostAddress!!, server.localPort, loopback, 0),
                    factory.createSocket(loopback, server.localPort),
                    factory.createSocket(loopback, server.localPort, loopback, 0),
                )
            sockets.forEach {
                assertTrue(it.isConnected)
                assertEquals(server.localPort, it.port)
                it.close()
            }
            assertEquals(sockets, given)
        }
    }

    @Test
    fun boundsANewConnectionsConnect() {
        val client = StalledConnections.configure(OkHttpClientProvider.createClientBuilder()).build()
        assertEquals(StalledConnections.CONNECT_TIMEOUT_MS.toInt(), client.connectTimeoutMillis)
    }

    @Test
    fun keepsReactNativesClientOtherwise() {
        // As `NetworkingModule` builds each request's client: its own, then ours on top.
        val cache = Cache(cacheDirectory, 1024 * 1024)
        val base = OkHttpClientProvider.createClientBuilder().cache(cache).build()
        val client = StalledConnections.configure(base.newBuilder()).build()
        assertSame(cache, client.cache)
        assertSame(base.connectionPool, client.connectionPool)
        assertEquals(0, client.pingIntervalMillis)
        assertEquals(0, client.readTimeoutMillis)
        assertEquals(0, client.writeTimeoutMillis)
        assertTrue(client.cookieJar is ReactCookieJarContainer)
    }

    @Test
    fun registersWithReactNativesNetworkingByDefault() {
        // `MainApplication`'s call: React Native's own slot, emptied after the test.
        StalledConnections.register()
    }

    @Test
    fun registersWithReactNativesNetworking() {
        val installed = mutableListOf<CustomClientBuilder>()
        StalledConnections.register { installed += it }
        StalledConnections.register { installed += it }
        // One builder, giving every request's client one socket factory.
        assertSame(installed[0], installed[1])
        val clients =
            List(2) {
                val builder = OkHttpClientProvider.createClientBuilder()
                installed[0].apply(builder)
                builder.build()
            }
        assertSame(StalledConnections.socketFactory, clients[0].socketFactory)
        assertSame(clients[0].socketFactory, clients[1].socketFactory)
        assertEquals(StalledConnections.CONNECT_TIMEOUT_MS.toInt(), clients[0].connectTimeoutMillis)
    }
}
