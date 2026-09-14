package co.gamestation.cameraman.core

import java.net.ServerSocket

/**
 * Answers "can this build actually bind that port?" empirically.
 *
 * The answer differs from iOS and it is not a matter of opinion. iOS applies no privileged-port
 * restriction, so 554 works on an iPhone — measured on an iPhone 13 Pro on 2026-08-19, including a
 * full RTSP exchange from a Mac on the same subnet. Android is Linux, and an unprivileged process
 * cannot bind below 1024 at all: 554 fails with EACCES on every handset, every time. This is what
 * records that as a measurement rather than a belief, and it is why both builds serve on 8554.
 */
object PortProbe {
    sealed interface Outcome {
        val description: String

        data object Bound : Outcome {
            override val description: String get() = "bound"
        }

        data class Refused(val reason: String) : Outcome {
            override val description: String get() = "refused: $reason"
        }
    }

    fun probe(port: Int): Outcome {
        if (port !in 1..65535) return Outcome.Refused("not a valid port number")
        return try {
            ServerSocket().use { socket ->
                socket.reuseAddress = true
                socket.bind(java.net.InetSocketAddress(port))
                Outcome.Bound
            }
        } catch (error: Exception) {
            Outcome.Refused(error.message ?: error.javaClass.simpleName)
        }
    }

    fun report(ports: List<Int>): Map<String, String> =
        ports.associate { it.toString() to probe(it).description }
}
