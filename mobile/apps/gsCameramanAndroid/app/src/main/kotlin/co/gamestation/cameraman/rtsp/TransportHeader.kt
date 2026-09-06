package co.gamestation.cameraman.rtsp

/**
 * The `Transport` header a client sends with `SETUP`, per RFC 2326 §12.39.
 *
 * Only TCP interleaving is accepted. UDP would mean discovering the client's address, holding two
 * sockets per track and handling NAT, and every client this camera serves — GS Producer, ffmpeg and
 * VLC — falls back to interleaved when offered nothing else.
 */
data class TransportHeader(
    val lower: Lower,
    /** Present only for interleaved TCP. The data channel; control is conventionally the next up. */
    val interleavedChannels: Channels? = null,
    val isMulticast: Boolean = false
) {
    enum class Lower { TCP, UDP }

    data class Channels(val data: Int, val control: Int)

    /**
     * The header echoed back in the SETUP response. The client reads the channel numbers from here,
     * so they must be the ones the server will actually use rather than the ones requested.
     */
    fun responseValue(dataChannel: Int, controlChannel: Int): String =
        "RTP/AVP/TCP;unicast;interleaved=$dataChannel-$controlChannel"

    companion object {
        /**
         * A client may offer several transports separated by commas, in descending preference. The
         * first one this server can honour wins; returning null means none of them.
         */
        fun parse(value: String): TransportHeader? {
            for (specification in value.split(",")) {
                parseSpecification(specification)?.let { return it }
            }
            return null
        }

        private fun parseSpecification(specification: String): TransportHeader? {
            val parameters = specification.split(";").map { it.trim() }
            val profile = parameters.firstOrNull()?.uppercase() ?: return null
            if (!profile.startsWith("RTP/AVP")) return null

            val isTCP = profile == "RTP/AVP/TCP"
            var isMulticast = false
            var channels: Channels? = null

            for (parameter in parameters.drop(1)) {
                val parts = parameter.split("=", limit = 2)
                when (parts[0].lowercase()) {
                    "multicast" -> isMulticast = true
                    "interleaved" -> {
                        if (parts.size != 2) continue
                        channels = parseChannels(parts[1])
                    }
                }
            }

            if (!isTCP || isMulticast) return null
            return TransportHeader(Lower.TCP, channels, false)
        }

        /** `interleaved=0-1`, or a bare `interleaved=0` which implies control is the next one. */
        private fun parseChannels(value: String): Channels? {
            val parts = value.split("-")
            val data = parts.firstOrNull()?.toIntOrNull() ?: return null
            if (data !in 0..255) return null
            if (parts.size > 1) {
                val control = parts[1].toIntOrNull() ?: return null
                if (control !in 0..255) return null
                return Channels(data, control)
            }
            if (data >= 255) return null
            return Channels(data, data + 1)
        }
    }
}
