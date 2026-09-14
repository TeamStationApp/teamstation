package co.gamestation.cameraman.rtsp

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import co.gamestation.cameraman.core.CameraParameters
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
    private val requestKeyframe: () -> Unit,
    /**
     * The TCP send buffer each new client gets, or null for the platform's own. Asked per accept,
     * because it is sized from the bitrate in force at the time.
     */
    private val sendBufferBytes: () -> Int? = { null },
    /** Answers `GET_PARAMETER` / `SET_PARAMETER` bodies. Null offers no parameters. */
    private val parameters: RTSPParameterHandler? = null
) {
    data class Status(
        val isListening: Boolean = false,
        /** The port actually bound. Null while the listener is down. */
        val port: Int? = null,
        /**
         * Sessions currently playing. A connection that only polls parameters is not a viewer and
         * is not counted here; [acceptedClients] still counts it.
         */
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
    )

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
     * Binds [port] and nothing else: Director looks for a Cameraman on one port, so a phone that
     * quietly moved elsewhere would be a camera nobody finds. A bind failure is a visible status
     * rather than a thrown error, because the app has to keep running and show the operator why.
     */
    fun start(port: Int, path: String, advertise: Boolean = true) {
        stop()
        lock.withLock {
            wantsAdvertisement = advertise
            advertisedPath = path
        }
        bind(port, path, advertise)
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

    private fun bind(port: Int, path: String, advertise: Boolean): Boolean {
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
            requestKeyframe = requestKeyframe,
            parameters = parameters,
            sendBufferBytes = sendBufferBytes()
        )
        client.onClose = { reason -> noteDisconnect(client, reason) }
        client.onStreamingChange = { recountClients() }

        val updated = lock.withLock {
            connections[client] = Unit
            status = status.copy(
                clientCount = playingCount(connections.keys),
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
                clientCount = playingCount(connections.keys),
                closedClients = status.closedClients + 1,
                lastDisconnectReason = reason
            )
            status
        }
        onStatusChange?.invoke(updated)
    }

    /** A connection started or stopped playing; the viewer count follows it. */
    private fun recountClients() {
        val updated = lock.withLock {
            val playing = playingCount(connections.keys)
            if (playing == status.clientCount) return@withLock null
            status = status.copy(clientCount = playing)
            status
        } ?: return
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

    /**
     * The worst playing client's link since the previous call, or null when nobody is playing.
     *
     * Every connection is sampled, playing or not, so each one's interval starts from this call
     * rather than from whenever it last happened to be the worst.
     */
    fun sampleCongestion(): CongestionSample? {
        val now = System.nanoTime() / 1e9
        val clients = lock.withLock { connections.keys.toList() }
        return CongestionSample.worst(clients.mapNotNull { it.congestionSample(now) })
    }

    companion object {
        const val bonjourServiceType = "_rtsp._tcp"

        /**
         * Advertised so a client knows this build answers `GET_PARAMETER` / `SET_PARAMETER` before
         * it offers a control screen. An older build without it shows no controls instead of a
         * screen that cannot connect.
         */
        const val controlVersion = CameraParameters.controlVersion

        private fun playingCount(connections: Collection<RTSPClientConnection>): Int =
            connections.count { it.isStreaming }

        /**
         * The type NearStream uses, and the one Director's browse actually finds on a split
         * 2.4/5 GHz LAN.
         */
        const val awxServiceType = "_awx_service._tcp"

        /**
         * TXT keys Director reads for Cameraman identity. `uuid` is the CNAME; `name` is the label.
         * `ip` / `port` let GS Director bind without resolving the advertised hostname, which often
         * has no usable A-record from another handset. `control` says the parameter verbs are
         * answered.
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
                "path" to path,
                "control" to controlVersion
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

            // Cellular never: it is not the field's network, and for the moments Wi-Fi drops it is
            // the only address left, which moved an iPhone's live tile to 203.0.113.16 for 20 s. Some
            // carriers hand out 10.x on cellular, so the interface is excluded as well as the range.
            return addresses
                .filter { (name, ip) -> !isCellular(name) && isPrivateIPv4(ip) }
                .minByOrNull { (name, _) -> rank(name) }
                ?.second
        }

        private fun isCellular(interfaceName: String): Boolean =
            interfaceName.startsWith("rmnet") || interfaceName.startsWith("ccmni") ||
                interfaceName.startsWith("v4-rmnet") || interfaceName.startsWith("v4-ccmni")

        /** 10/8, 172.16/12 or 192.168/16: the addresses a Director on the same network can dial. */
        fun isPrivateIPv4(ip: String): Boolean {
            val octets = ip.split(".").mapNotNull { it.toIntOrNull()?.takeIf { value -> value in 0..255 } }
            if (octets.size != 4) return false
            return octets[0] == 10 ||
                (octets[0] == 172 && octets[1] in 16..31) ||
                (octets[0] == 192 && octets[1] == 168)
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
