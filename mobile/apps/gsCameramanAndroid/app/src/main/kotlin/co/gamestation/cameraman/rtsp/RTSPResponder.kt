package co.gamestation.cameraman.rtsp

import kotlin.random.Random

/**
 * Turns one client's requests into responses.
 *
 * Pure and synchronous on purpose: the whole RTSP method sequence, including the error paths a real
 * client provokes, is testable without a socket, a camera or an encoder.
 */
class RTSPResponder(
    val sessionIdentifier: String,
    val sdp: String,
    val hasAudio: Boolean
) {
    data class Setup(val track: Track, val dataChannel: Int, val controlChannel: Int) {
        enum class Track { VIDEO, AUDIO }
    }

    enum class State { INITIAL, READY, PLAYING }

    /** What the connection should do after answering, beyond sending the response. */
    sealed interface Effect {
        data object None : Effect
        data class StartStreaming(val video: Setup, val audio: Setup?) : Effect
        data object StopStreaming : Effect
        data object Close : Effect
    }

    data class Outcome(val response: RTSPServerResponse, val effect: Effect)

    var state: State = State.INITIAL
        private set
    var videoSetup: Setup? = null
        private set
    var audioSetup: Setup? = null
        private set

    fun respond(request: RTSPServerRequest): Outcome {
        val cseq = request.cseq

        // Once a session exists, a request carrying the wrong identifier must not be allowed to act
        // on it. RFC 2326 §11.3.14 is the status code for that.
        val session = request.session
        if (session != null && session != sessionIdentifier) {
            return Outcome(
                RTSPServerResponse.status(454, "Session Not Found", cseq),
                Effect.None
            )
        }

        return when (request.method) {
            "OPTIONS" -> Outcome(options(cseq), Effect.None)
            "DESCRIBE" -> Outcome(describe(request, cseq), Effect.None)
            "SETUP" -> setup(request, cseq)
            "PLAY" -> play(cseq)
            "PAUSE" -> pause(cseq)
            "TEARDOWN" -> {
                state = State.INITIAL
                videoSetup = null
                audioSetup = null
                Outcome(
                    RTSPServerResponse(headers = base(cseq, includeSession = true)),
                    Effect.Close
                )
            }
            // Empty body means "keepalive", which is how every client holds a session open.
            "GET_PARAMETER" -> Outcome(
                RTSPServerResponse(headers = base(cseq, includeSession = state != State.INITIAL)),
                Effect.None
            )
            else -> Outcome(RTSPServerResponse.status(501, "Not Implemented", cseq), Effect.None)
        }
    }

    private fun options(cseq: String?): RTSPServerResponse {
        val headers = base(cseq, includeSession = false).toMutableList()
        headers.add("Public" to supportedMethods)
        return RTSPServerResponse(headers = headers)
    }

    private fun describe(request: RTSPServerRequest, cseq: String?): RTSPServerResponse {
        // A client that asks for a format this server cannot produce must be told so rather than
        // handed an SDP it did not ask for.
        val accept = request.headers["accept"]
        if (accept != null && !accept.lowercase().contains("application/sdp")) {
            return RTSPServerResponse.status(406, "Not Acceptable", cseq)
        }

        val headers = base(cseq, includeSession = false).toMutableList()
        headers.add("Content-Type" to "application/sdp")
        // RFC 2326 §12.11: without this the client resolves relative track controls against the
        // request URI, which differs from the URI this server considers canonical.
        headers.add(
            "Content-Base" to if (request.uri.endsWith("/")) request.uri else request.uri + "/"
        )
        return RTSPServerResponse(headers = headers, body = sdp.toByteArray(Charsets.UTF_8))
    }

    private fun setup(request: RTSPServerRequest, cseq: String?): Outcome {
        if (state == State.PLAYING) {
            // Changing transport mid-stream would mean renegotiating channels the sender is using.
            return Outcome(
                RTSPServerResponse.status(455, "Method Not Valid In This State", cseq),
                Effect.None
            )
        }
        val transportValue = request.headers["transport"]
            ?: return Outcome(RTSPServerResponse.status(400, "Bad Request", cseq), Effect.None)
        val transport = TransportHeader.parse(transportValue)
            // RFC 2326 §11.3.9, the specific code for "none of your offered transports".
            ?: return Outcome(
                RTSPServerResponse.status(461, "Unsupported Transport", cseq),
                Effect.None
            )
        val track = track(request.uri, hasAudio)
            ?: return Outcome(RTSPServerResponse.status(404, "Not Found", cseq), Effect.None)

        // Honour the client's channel numbers when it names them. ffmpeg assigns them itself and
        // reads its own numbers back, so overriding them silently sends media on channels it ignores.
        val channels = transport.interleavedChannels ?: defaultChannels(track)
        val setup = Setup(track, channels.data, channels.control)

        when (track) {
            Setup.Track.VIDEO -> videoSetup = setup
            Setup.Track.AUDIO -> audioSetup = setup
        }
        state = State.READY

        val headers = base(cseq, includeSession = true).toMutableList()
        headers.add(
            "Transport" to transport.responseValue(setup.dataChannel, setup.controlChannel)
        )
        return Outcome(RTSPServerResponse(headers = headers), Effect.None)
    }

    private fun play(cseq: String?): Outcome {
        val video = videoSetup
            // Nothing was set up, so there is no transport to send on.
            ?: return Outcome(
                RTSPServerResponse.status(455, "Method Not Valid In This State", cseq),
                Effect.None
            )

        state = State.PLAYING
        val headers = base(cseq, includeSession = true).toMutableList()
        // Live capture has no known start, so the range is open-ended. `RTP-Info` is added by the
        // connection, which is the only part that knows the sequence numbers it is about to send.
        headers.add("Range" to "npt=now-")
        return Outcome(
            RTSPServerResponse(headers = headers),
            Effect.StartStreaming(video, audioSetup)
        )
    }

    private fun pause(cseq: String?): Outcome {
        if (state != State.PLAYING) {
            return Outcome(
                RTSPServerResponse.status(455, "Method Not Valid In This State", cseq),
                Effect.None
            )
        }
        state = State.READY
        return Outcome(
            RTSPServerResponse(headers = base(cseq, includeSession = true)),
            Effect.StopStreaming
        )
    }

    private fun base(cseq: String?, includeSession: Boolean): List<Pair<String, String>> {
        val headers = ArrayList<Pair<String, String>>()
        if (cseq != null) headers.add("CSeq" to cseq)
        headers.add("Server" to "GS Cameraman/1.0")
        if (includeSession) {
            headers.add("Session" to "$sessionIdentifier;timeout=$sessionTimeout")
        }
        return headers
    }

    companion object {
        const val supportedMethods =
            "OPTIONS, DESCRIBE, SETUP, PLAY, PAUSE, TEARDOWN, GET_PARAMETER"

        /**
         * RFC 2326 §12.37. A client that sends no keepalive is dropped after this, which is what
         * stops a phone that walked out of range from holding the stream open forever.
         */
        const val sessionTimeout = 60

        /**
         * Matches the track from the control URL the SDP advertised. A URI naming no known track has
         * to be a 404 rather than a guess, since guessing sends video down a channel the client
         * reads as audio.
         */
        fun track(uri: String, hasAudio: Boolean): Setup.Track? {
            if (uri.contains(SDPBuilder.videoTrackControl)) return Setup.Track.VIDEO
            if (uri.contains(SDPBuilder.audioTrackControl)) {
                return if (hasAudio) Setup.Track.AUDIO else null
            }
            return null
        }

        fun defaultChannels(track: Setup.Track): TransportHeader.Channels = when (track) {
            Setup.Track.VIDEO ->
                TransportHeader.Channels(InterleavedChannel.video, InterleavedChannel.videoControl)
            Setup.Track.AUDIO ->
                TransportHeader.Channels(InterleavedChannel.audio, InterleavedChannel.audioControl)
        }

        /**
         * RFC 2326 gives no format for this beyond "8 or more octets". A random 64-bit value makes a
         * second client's guess at another client's session implausible.
         */
        fun generateSessionIdentifier(): String =
            java.lang.Long.toHexString(Random.nextLong(1L shl 40, Long.MAX_VALUE))
    }
}
