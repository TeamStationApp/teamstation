package co.gamestation.cameraman.rtsp

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import co.gamestation.cameraman.core.DeviceIdentity
import co.gamestation.cameraman.core.EncodedAudioFrame
import co.gamestation.cameraman.core.EncodedVideoFrame
import co.gamestation.cameraman.core.StreamCodec
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * The RTSP server: one `ServerSocket`, one [RTSPClientConnection] per client.
 *
 * Media is pushed from [send] rather than pulled, because the encoder runs whether or not anyone is
 * watching and its callbacks must never block on a socket.
 */
class RTSPServer(
    private val context: Context,
    /**
     * Takes the SSRCs the connection will actually send on, so the SDP's `a=ssrc` attributes name
     * the same streams the RTP does. Produced on demand rather than held, because the parameter sets
     * are not known until the encoder has produced its first frame and a client may DESCRIBE before
     * then.
     */
    private val describe: (Long, Long) -> String,
    private val hasAudio: () -> Boolean,
    private val identity: () -> DeviceIdentity,
    /**
     * Called when a client starts playing, so it gets a picture immediately instead of waiting out
     * the keyframe interval on frames whose references it never received.
     */
    private val requestKeyframe: () -> Unit
) {
    data class Status(
        val isListening: Boolean = false,
        val port: Int? = null,
        /** The port actually bound, which may be the fallback rather than the one asked for. */
        val requestedPort: Int? = null,
        val clientCount: Int = 0,
        val lastError: String? = null,
        /** Frames the send queue dropped across clients because a receiver could not keep up. */
        val droppedFrames: Int = 0,
        /** Lifetime accepts, including clients that closed immediately. */
        val acceptedClients: Int = 0,
        /** Lifetime closes. `acceptedClients - closedClients` should match `clientCount`. */
        val closedClients: Int = 0,
        /** Why the most recent client left: TEARDOWN, eof, recv, send, server stop, cancelled. */
        val lastDisconnectReason: String? = null,
        /** Bytes still sitting in client send queues. A climb with `clientCount > 0` is backpressure. */
        val sendQueuePendingBytes: Int = 0,
        val sendQueueFlushes: Int = 0,
        /** `ready` / `failed` / `stopped`, for a soak that lost the bind. */
        val listenerState: String? = null,
        /** Whether `_rtsp._tcp` is actually registered, not merely requested. */
        val isAdvertising: Boolean = false
    ) {
        val usedFallbackPort: Boolean
            get() = port != null && requestedPort != null && port != requestedPort
    }

    private val lock = ReentrantLock()
    private var listener: ServerSocket? = null
    private var acceptThread: Thread? = null
    private val connections = LinkedHashMap<RTSPClientConnection, Unit>()
    private var status = Status()
    private var registration: NsdManager.RegistrationListener? = null
    /**
     * A second advertisement of the same listener, under the type NearStream uses.
     *
     * Director's AWX browse is what actually finds cameras on a split 2.4/5 GHz LAN; `_rtsp._tcp`
     * from a phone often never appears there. Publishing both costs one more registration and means
     * Director finds this camera by whichever route works on the night.
     */
    private var awxRegistration: NsdManager.RegistrationListener? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var wantsAdvertisement = false
    private var advertisedPath = "/live/mainstream"

    private val nsdManager: NsdManager? by lazy {
        context.applicationContext.getSystemService(Context.NSD_SERVICE) as? NsdManager
    }

    var onStatusChange: ((Status) -> Unit)? = null

    fun currentStatus(): Status = lock.withLock { status }

    /**
     * Binds [port], falling back to [fallbackPort] if it is taken. A bind failure is a visible
     * status rather than a thrown error, because the app has to keep running and show the operator
     * why.
     *
     * On a handset the first attempt always fails: 554 is privileged and Linux refuses it to an
     * unprivileged process. The attempt is still made so the fallback is a recorded fact rather than
     * a hardcoded port that quietly differs from what the iOS build uses.
     */
    fun start(port: Int, fallbackPort: Int, path: String, advertise: Boolean = true) {
        stop()
        lock.withLock {
            wantsAdvertisement = advertise
            advertisedPath = path
        }
        if (!bind(port, port, path, advertise)) {
            bind(fallbackPort, port, path, advertise)
        }
    }

    fun stop() {
        stopNetworkMonitor()
        val (socket, clients) = lock.withLock {
            val result = listener to connections.keys.toList()
            listener = null
            connections.clear()
            result
        }
        unregisterAdvertisement()
        runCatching { socket?.close() }
        acceptThread?.interrupt()
        acceptThread = null
        for (client in clients) client.close()
        update {
            it.copy(
                isListening = false,
                port = null,
                clientCount = 0,
                listenerState = "stopped",
                isAdvertising = false
            )
        }
    }

    /**
     * Re-publishes `_rtsp._tcp` under the current name. A rename that only updated the in-memory
     * identity would otherwise keep advertising the old instance until the listener was restarted.
     *
     * `NsdManager` has no update call — the TXT record and the instance name are fixed at
     * registration — so this unregisters and registers again. Director sees the old instance go and
     * the new one arrive, which is the same thing Bonjour does on iOS when the instance name
     * changes.
     */
    fun refreshAdvertisement() {
        val (port, path, wants) = lock.withLock {
            Triple(status.port, advertisedPath, wantsAdvertisement)
        }
        if (!wants || port == null) return
        unregisterAdvertisement()
        registerAdvertisement(port, path)
    }

    private fun bind(port: Int, requested: Int, path: String, advertise: Boolean): Boolean {
        val socket = try {
            ServerSocket().apply {
                // Without this a listener that was not cleanly torn down leaves the port unusable
                // for a minute, which on a relaunch looks exactly like another app holding it.
                reuseAddress = true
                bind(InetSocketAddress(port), 8)
            }
        } catch (error: Exception) {
            update {
                it.copy(
                    lastError = "could not bind $port: ${error.message ?: error.javaClass.simpleName}"
                )
            }
            return false
        }

        val bound = socket.localPort
        lock.withLock { listener = socket }
        update {
            it.copy(
                isListening = true,
                port = bound,
                requestedPort = requested,
                lastError = null,
                listenerState = "ready"
            )
        }

        if (advertise) {
            registerAdvertisement(bound, path)
            startNetworkMonitor()
        }

        acceptThread = Thread({ acceptLoop(socket) }, "rtsp-accept").apply {
            isDaemon = true
            start()
        }
        return true
    }

    private fun acceptLoop(socket: ServerSocket) {
        while (!socket.isClosed) {
            val client = try {
                socket.accept()
            } catch (error: Exception) {
                if (!socket.isClosed) {
                    update {
                        it.copy(
                            isListening = false,
                            listenerState = "failed",
                            lastError = "accept failed: ${error.message ?: error.javaClass.simpleName}"
                        )
                    }
                }
                return
            }
            accept(client)
        }
    }

    private fun accept(socket: java.net.Socket) {
        val client = RTSPClientConnection(
            socket = socket,
            sdp = describe,
            hasAudio = hasAudio(),
            identity = identity,
            requestKeyframe = requestKeyframe
        )
        client.onClose = { reason -> noteDisconnect(client, reason) }

        val updated = lock.withLock {
            connections[client] = Unit
            status = status.copy(
                clientCount = connections.size,
                acceptedClients = status.acceptedClients + 1
            )
            status
        }
        onStatusChange?.invoke(updated)
        client.start()
    }

    private fun noteDisconnect(client: RTSPClientConnection, reason: String) {
        val updated = lock.withLock {
            connections.remove(client)
            status = status.copy(
                clientCount = connections.size,
                closedClients = status.closedClients + 1,
                lastDisconnectReason = reason
            )
            status
        }
        onStatusChange?.invoke(updated)
    }

    private fun update(change: (Status) -> Status) {
        val updated = lock.withLock {
            status = change(status)
            status
        }
        onStatusChange?.invoke(updated)
    }

    // MARK: - Discovery

    /**
     * `_rtsp._tcp` over NSD, so a client finds the phone without being told an address that changes
     * with the lease. This is Android's mDNS responder rather than Bonjour, but it is the same
     * protocol on the wire and Director's browser does not know the difference.
     *
     * The iOS build needs `NSBonjourServices` in Info.plist or registration fails with -65555 and
     * takes the listener down with it. Android has no equivalent declaration, and a failed
     * registration here leaves the socket alone — which is why [Status.isAdvertising] is reported
     * separately from [Status.isListening] rather than being assumed from it.
     */
    private fun registerAdvertisement(port: Int, path: String) {
        registerRTSP(port, path)
        registerAWX(port, path)
    }

    private fun registerAWX(port: Int, path: String) {
        val manager = nsdManager ?: return
        val identity = identity()
        val info = NsdServiceInfo().apply {
            serviceName = identity.name
            serviceType = awxServiceType
            setPort(port)
        }
        for ((key, value) in bonjourTXT(identity, path, lanIPv4(), port)) {
            info.setAttribute(key, value)
        }
        // Its own listener, and its failures are not reported as the app's advertising state: the
        // RTSP type is the contract, and this one is the belt to its braces.
        val listener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(info: NsdServiceInfo) = Unit
            override fun onRegistrationFailed(info: NsdServiceInfo, errorCode: Int) = Unit
            override fun onServiceUnregistered(info: NsdServiceInfo) = Unit
            override fun onUnregistrationFailed(info: NsdServiceInfo, errorCode: Int) = Unit
        }
        awxRegistration = listener
        runCatching { manager.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener) }
            .onFailure { awxRegistration = null }
    }

    private fun registerRTSP(port: Int, path: String) {
        val manager = nsdManager ?: return
        val identity = identity()
        val info = NsdServiceInfo().apply {
            serviceName = identity.name
            serviceType = bonjourServiceType
            setPort(port)
        }
        for ((key, value) in bonjourTXT(identity, path, lanIPv4(), port)) {
            info.setAttribute(key, value)
        }

        val listener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(info: NsdServiceInfo) {
                update { it.copy(isAdvertising = true) }
            }

            override fun onRegistrationFailed(info: NsdServiceInfo, errorCode: Int) {
                update {
                    it.copy(
                        isAdvertising = false,
                        lastError = "advertisement failed with $errorCode"
                    )
                }
            }

            override fun onServiceUnregistered(info: NsdServiceInfo) {
                update { it.copy(isAdvertising = false) }
            }

            override fun onUnregistrationFailed(info: NsdServiceInfo, errorCode: Int) = Unit
        }
        registration = listener
        runCatching {
            manager.registerService(info, NsdManager.PROTOCOL_DNS_SD, listener)
        }.onFailure { error ->
            registration = null
            update {
                it.copy(
                    isAdvertising = false,
                    lastError = "advertisement failed: ${error.message}"
                )
            }
        }
    }

    private fun unregisterAdvertisement() {
        // Unregistering a listener that never registered throws, and there is no state to ask.
        registration?.let { listener ->
            registration = null
            runCatching { nsdManager?.unregisterService(listener) }
        }
        awxRegistration?.let { listener ->
            awxRegistration = null
            runCatching { nsdManager?.unregisterService(listener) }
        }
    }

    /**
     * Re-advertises when the network path changes.
     *
     * The TXT record carries the address Director dials, and that address changes with the lease —
     * roaming between access points, or a Wi-Fi drop and rejoin. Without this the advertisement
     * keeps naming an address nothing answers on, which looks exactly like a camera that died.
     */
    private fun startNetworkMonitor() {
        if (networkCallback != null) return
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = refreshAdvertisement()
            override fun onLost(network: Network) = refreshAdvertisement()
            override fun onCapabilitiesChanged(
                network: Network,
                capabilities: NetworkCapabilities
            ) = refreshAdvertisement()
        }
        val request = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET)
            .build()
        runCatching { manager.registerNetworkCallback(request, callback) }
            .onSuccess { networkCallback = callback }
    }

    private fun stopNetworkMonitor() {
        val callback = networkCallback ?: return
        networkCallback = null
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        runCatching { manager?.unregisterNetworkCallback(callback) }
    }

    // MARK: - Media

    fun send(frame: EncodedVideoFrame, codec: StreamCodec) {
        val clients = lock.withLock { connections.keys.toList() }
        for (client in clients) client.send(frame, codec)
    }

    fun send(frame: EncodedAudioFrame) {
        val clients = lock.withLock { connections.keys.toList() }
        for (client in clients) client.send(frame)
    }

    /**
     * Aggregate backpressure across clients, for the HUD. A single slow client is worth seeing
     * before it is diagnosed as an encoder problem.
     */
    fun sendQueueSummaries(): List<StreamSendQueue.Snapshot> =
        lock.withLock { connections.keys.toList() }.map { it.sendQueue.snapshot() }

    companion object {
        const val bonjourServiceType = "_rtsp._tcp"

        /**
         * The type NearStream uses, and the one Director's browse actually finds on a split
         * 2.4/5 GHz LAN.
         */
        const val awxServiceType = "_awx_service._tcp"

        /**
         * TXT keys Director reads for Cameraman identity. `uuid` is the CNAME; `name` is the label.
         * `ip` / `port` let GS Director bind without resolving the advertised hostname, which often
         * has no usable A-record from another handset.
         */
        fun bonjourTXT(
            identity: DeviceIdentity,
            path: String,
            ip: String? = null,
            port: Int? = null
        ): Map<String, String> {
            val fields = linkedMapOf(
                "uuid" to identity.cname,
                "name" to identity.name,
                "path" to path
            )
            if (!ip.isNullOrEmpty()) fields["ip"] = ip
            if (port != null && port > 0) fields["port"] = port.toString()
            return fields
        }

        /**
         * The Wi-Fi IPv4 address. Director cannot use the advertised hostname as an RTSP URL.
         *
         * `wlan0` rather than iOS's `en0`, and loopback, link-local and the tethering bridges are
         * excluded for the same reason they are there: an address a client on the field cannot
         * route to is worse than no address at all, because it looks like one that should work.
         */
        fun lanIPv4(): String? {
            val interfaces = runCatching {
                NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
            }.getOrDefault(emptyList())

            val addresses = ArrayList<Pair<String, String>>()
            for (candidate in interfaces) {
                if (!runCatching { candidate.isUp }.getOrDefault(false)) continue
                if (runCatching { candidate.isLoopback }.getOrDefault(true)) continue
                for (address in candidate.inetAddresses) {
                    if (address !is java.net.Inet4Address) continue
                    val text = address.hostAddress ?: continue
                    addresses.add(candidate.name to text)
                }
            }
            return preferredLANIPv4(addresses)
        }

        /**
         * Picks the IPv4 Director should dial.
         *
         * Wi-Fi wins, then anything else infrastructure. USB tethering and Wi-Fi Direct rank below
         * both and loopback and link-local never rank at all, because handing Director an address it
         * cannot reach is worse than handing it none — it looks like a camera that is up and
         * refusing connections rather than one that has not found the network yet.
         */
        fun preferredLANIPv4(addresses: List<Pair<String, String>>): String? {
            fun rank(interfaceName: String): Int = when {
                interfaceName.startsWith("wlan") -> 0
                interfaceName.startsWith("eth") -> 1
                interfaceName.startsWith("rndis") || interfaceName.startsWith("usb") -> 3
                // Wi-Fi Direct and tethering hotspots: reachable, but not the match-day network.
                interfaceName.startsWith("p2p") || interfaceName.startsWith("ap") -> 5
                interfaceName.startsWith("tun") || interfaceName.startsWith("ipsec") -> 6
                else -> 4
            }

            return addresses
                .filter { (_, ip) -> ip != "127.0.0.1" && !ip.startsWith("169.254.") }
                .minByOrNull { (name, _) -> rank(name) }
                ?.second
        }

        /** Every IPv4 this device answers on, for the state dump. */
        fun localAddresses(): List<String> {
            val result = ArrayList<String>()
            val interfaces = runCatching {
                NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
            }.getOrDefault(emptyList())
            for (candidate in interfaces) {
                if (!runCatching { candidate.isUp }.getOrDefault(false)) continue
                for (address in candidate.inetAddresses) {
                    if (address !is java.net.Inet4Address) continue
                    address.hostAddress?.let { result.add(it) }
                }
            }
            return result
        }
    }
}
