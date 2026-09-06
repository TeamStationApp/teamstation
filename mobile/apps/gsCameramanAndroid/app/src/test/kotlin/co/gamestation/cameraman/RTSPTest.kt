package co.gamestation.cameraman

import co.gamestation.cameraman.core.CameraParameterSet
import co.gamestation.cameraman.core.CameraParameters
import co.gamestation.cameraman.core.CameraSnapshot
import co.gamestation.cameraman.core.DeviceIdentity
import co.gamestation.cameraman.core.ParameterOutcome
import co.gamestation.cameraman.core.StreamCodec
import co.gamestation.cameraman.rtsp.RTCPWriter
import co.gamestation.cameraman.rtsp.RTSPResponder
import co.gamestation.cameraman.rtsp.RTSPServer
import co.gamestation.cameraman.rtsp.RTSPServerRequest
import co.gamestation.cameraman.rtsp.RTSPServerResponse
import co.gamestation.cameraman.rtsp.SDPBuilder
import co.gamestation.cameraman.rtsp.TransportHeader
import java.io.EOFException
import java.net.Socket
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TransportHeaderTest {

    @Test
    fun `accepts interleaved TCP and keeps the client's channels`() {
        val header = TransportHeader.parse("RTP/AVP/TCP;unicast;interleaved=4-5")
        assertNotNull(header)
        assertEquals(TransportHeader.Lower.TCP, header!!.lower)
        assertEquals(TransportHeader.Channels(4, 5), header.interleavedChannels)
    }

    @Test
    fun `a bare interleaved value implies the next channel for control`() {
        val header = TransportHeader.parse("RTP/AVP/TCP;unicast;interleaved=0")
        assertEquals(TransportHeader.Channels(0, 1), header?.interleavedChannels)
    }

    @Test
    fun `UDP and multicast are refused rather than quietly answered with something else`() {
        assertNull(TransportHeader.parse("RTP/AVP;unicast;client_port=5000-5001"))
        assertNull(TransportHeader.parse("RTP/AVP/UDP;unicast;client_port=5000-5001"))
        assertNull(TransportHeader.parse("RTP/AVP/TCP;multicast;interleaved=0-1"))
        assertNull(TransportHeader.parse("RAW/RAW/UDP;unicast"))
    }

    @Test
    fun `the first honourable transport in a list wins`() {
        // ffmpeg offers UDP first and falls back to interleaved, all in one header.
        val header = TransportHeader.parse(
            "RTP/AVP;unicast;client_port=5000-5001,RTP/AVP/TCP;unicast;interleaved=0-1"
        )
        assertEquals(TransportHeader.Channels(0, 1), header?.interleavedChannels)
    }

    @Test
    fun `the response echoes the channels the server will actually use`() {
        val header = TransportHeader(TransportHeader.Lower.TCP)
        assertEquals(
            "RTP/AVP/TCP;unicast;interleaved=2-3",
            header.responseValue(2, 3)
        )
    }

    @Test
    fun `channel numbers outside a byte are refused`() {
        assertNull(TransportHeader.parse("RTP/AVP/TCP;unicast;interleaved=300-301")?.interleavedChannels)
    }
}

class RTSPServerMessageTest {

    @Test
    fun `parses a request and reports how much it consumed`() {
        val text = "DESCRIBE rtsp://host/live/mainstream RTSP/1.0\r\n" +
            "CSeq: 2\r\nAccept: application/sdp\r\n\r\n"
        val parsed = RTSPServerRequest.parse(text.toByteArray())
        assertNotNull(parsed)
        assertEquals("DESCRIBE", parsed!!.request.method)
        assertEquals("rtsp://host/live/mainstream", parsed.request.uri)
        assertEquals("2", parsed.request.cseq)
        // Lower-cased keys, because no client agrees with any other about capitalisation.
        assertEquals("application/sdp", parsed.request.headers["accept"])
        assertEquals(text.length, parsed.consumed)
    }

    @Test
    fun `an incomplete request is not an error`() {
        // The normal case on a streaming socket: half a request has arrived.
        assertNull(RTSPServerRequest.parse("OPTIONS rtsp://host RTSP/1.0\r\nCSeq: 1".toByteArray()))
    }

    @Test
    fun `pipelined requests are parsed one at a time`() {
        val first = "OPTIONS rtsp://host RTSP/1.0\r\nCSeq: 1\r\n\r\n"
        val second = "DESCRIBE rtsp://host RTSP/1.0\r\nCSeq: 2\r\n\r\n"
        var buffer = (first + second).toByteArray()

        val one = RTSPServerRequest.parse(buffer)!!
        assertEquals("OPTIONS", one.request.method)
        buffer = buffer.copyOfRange(one.consumed, buffer.size)
        val two = RTSPServerRequest.parse(buffer)!!
        assertEquals("DESCRIBE", two.request.method)
        assertEquals(buffer.size, two.consumed)
    }

    @Test
    fun `bare LF line endings are accepted`() {
        val parsed = RTSPServerRequest.parse("OPTIONS rtsp://host RTSP/1.0\nCSeq: 1\n\n".toByteArray())
        assertEquals("1", parsed?.request?.cseq)
    }

    @Test
    fun `a folded header keeps its continuation`() {
        // Splitting on newlines alone silently loses the remainder of a wrapped value.
        val parsed = RTSPServerRequest.parse(
            "SETUP rtsp://host RTSP/1.0\r\nCSeq: 1\r\nTransport: RTP/AVP/TCP;\r\n unicast;interleaved=0-1\r\n\r\n".toByteArray()
        )
        assertEquals(
            "RTP/AVP/TCP; unicast;interleaved=0-1",
            parsed?.request?.headers?.get("transport")
        )
    }

    @Test
    fun `a body is only read once all of it has arrived`() {
        val head = "SET_PARAMETER rtsp://host RTSP/1.0\r\nCSeq: 4\r\nContent-Length: 5\r\n\r\n"
        assertNull(RTSPServerRequest.parse((head + "abc").toByteArray()))
        val parsed = RTSPServerRequest.parse((head + "abcde").toByteArray())
        assertEquals("abcde", String(parsed!!.request.body))
    }

    @Test
    fun `the session identifier drops a timeout parameter the client echoed back`() {
        val parsed = RTSPServerRequest.parse(
            "PLAY rtsp://host RTSP/1.0\r\nCSeq: 3\r\nSession: 1234abcd;timeout=60\r\n\r\n".toByteArray()
        )
        assertEquals("1234abcd", parsed?.request?.session)
    }

    @Test
    fun `a response writes Content-Length only when there is a body`() {
        val empty = RTSPServerResponse(headers = listOf("CSeq" to "1")).wireFormat
        assertEquals("RTSP/1.0 200 OK\r\nCSeq: 1\r\n\r\n", String(empty))

        val withBody = RTSPServerResponse(
            headers = listOf("CSeq" to "2"),
            body = "v=0\r\n".toByteArray()
        ).wireFormat
        assertTrue(String(withBody).contains("Content-Length: 5\r\n"))
    }

    @Test
    fun `an error response still echoes CSeq`() {
        // A client that cannot match the response to its request treats the session as desynchronised.
        val response = RTSPServerResponse.status(461, "Unsupported Transport", "7")
        assertTrue(String(response.wireFormat).startsWith("RTSP/1.0 461 Unsupported Transport\r\nCSeq: 7\r\n"))
    }
}

class RTSPResponderTest {
    private fun responder() = RTSPResponder(
        sessionIdentifier = "1234abcd",
        sdp = "v=0\r\n",
        hasAudio = true
    )

    private fun request(
        method: String,
        uri: String = "rtsp://host/live/mainstream",
        headers: Map<String, String> = mapOf("cseq" to "1")
    ) = RTSPServerRequest(method, uri, headers)

    @Test
    fun `OPTIONS lists what this server actually implements`() {
        val outcome = responder().respond(request("OPTIONS"))
        val public = outcome.response.headers.first { it.first == "Public" }.second
        assertEquals(RTSPResponder.supportedMethods, public)
        assertFalse(public.contains("RECORD"))
        assertFalse(public.contains("ANNOUNCE"))
    }

    @Test
    fun `DESCRIBE returns the SDP with a Content-Base`() {
        val outcome = responder().respond(
            request("DESCRIBE", headers = mapOf("cseq" to "2", "accept" to "application/sdp"))
        )
        assertEquals(200, outcome.response.statusCode)
        assertEquals("v=0\r\n", String(outcome.response.body))
        // Without this the client resolves relative track controls against the request URI.
        assertEquals(
            "rtsp://host/live/mainstream/",
            outcome.response.headers.first { it.first == "Content-Base" }.second
        )
    }

    @Test
    fun `DESCRIBE refuses a format this server cannot produce`() {
        val outcome = responder().respond(
            request("DESCRIBE", headers = mapOf("cseq" to "2", "accept" to "application/mikey"))
        )
        assertEquals(406, outcome.response.statusCode)
    }

    @Test
    fun `SETUP without a Transport header is a bad request`() {
        val outcome = responder().respond(request("SETUP", uri = "rtsp://host/live/trackID=0"))
        assertEquals(400, outcome.response.statusCode)
    }

    @Test
    fun `SETUP offering only UDP is 461, not a silently different transport`() {
        val outcome = responder().respond(
            request(
                "SETUP",
                uri = "rtsp://host/live/trackID=0",
                headers = mapOf("cseq" to "1", "transport" to "RTP/AVP;unicast;client_port=5000-5001")
            )
        )
        assertEquals(461, outcome.response.statusCode)
    }

    @Test
    fun `SETUP for an unknown track is 404 rather than a guess`() {
        // Guessing sends video down a channel the client reads as audio.
        val outcome = responder().respond(
            request(
                "SETUP",
                uri = "rtsp://host/live/trackID=9",
                headers = mapOf("cseq" to "1", "transport" to "RTP/AVP/TCP;unicast;interleaved=0-1")
            )
        )
        assertEquals(404, outcome.response.statusCode)
    }

    @Test
    fun `SETUP honours the channels the client named`() {
        val responder = responder()
        val outcome = responder.respond(
            request(
                "SETUP",
                uri = "rtsp://host/live/trackID=0",
                headers = mapOf("cseq" to "1", "transport" to "RTP/AVP/TCP;unicast;interleaved=6-7")
            )
        )
        assertEquals(200, outcome.response.statusCode)
        assertEquals(
            "RTP/AVP/TCP;unicast;interleaved=6-7",
            outcome.response.headers.first { it.first == "Transport" }.second
        )
        assertEquals(6, responder.videoSetup?.dataChannel)
        assertEquals(RTSPResponder.State.READY, responder.state)
    }

    @Test
    fun `PLAY before SETUP is refused rather than streaming into nothing`() {
        val outcome = responder().respond(request("PLAY"))
        assertEquals(455, outcome.response.statusCode)
        assertEquals(RTSPResponder.Effect.None, outcome.effect)
    }

    @Test
    fun `a full OPTIONS DESCRIBE SETUP PLAY sequence starts streaming`() {
        val responder = responder()
        responder.respond(request("OPTIONS"))
        responder.respond(request("DESCRIBE"))
        responder.respond(
            request(
                "SETUP",
                uri = "rtsp://host/live/trackID=0",
                headers = mapOf("cseq" to "3", "transport" to "RTP/AVP/TCP;unicast;interleaved=0-1")
            )
        )
        responder.respond(
            request(
                "SETUP",
                uri = "rtsp://host/live/trackID=1",
                headers = mapOf("cseq" to "4", "transport" to "RTP/AVP/TCP;unicast;interleaved=2-3")
            )
        )
        val play = responder.respond(request("PLAY", headers = mapOf("cseq" to "5")))

        assertEquals(200, play.response.statusCode)
        val effect = play.effect
        assertTrue(effect is RTSPResponder.Effect.StartStreaming)
        effect as RTSPResponder.Effect.StartStreaming
        assertEquals(0, effect.video.dataChannel)
        assertEquals(2, effect.audio?.dataChannel)
        assertEquals(RTSPResponder.State.PLAYING, responder.state)
        // Live capture has no known start, so the range is open-ended.
        assertEquals("npt=now-", play.response.headers.first { it.first == "Range" }.second)
    }

    @Test
    fun `SETUP mid-stream is refused rather than renegotiating live channels`() {
        val responder = responder()
        setupAndPlay(responder)
        val outcome = responder.respond(
            request(
                "SETUP",
                uri = "rtsp://host/live/trackID=0",
                headers = mapOf("cseq" to "9", "transport" to "RTP/AVP/TCP;unicast;interleaved=8-9")
            )
        )
        assertEquals(455, outcome.response.statusCode)
    }

    @Test
    fun `PAUSE stops sending and keeps the session`() {
        val responder = responder()
        setupAndPlay(responder)
        val outcome = responder.respond(request("PAUSE", headers = mapOf("cseq" to "6")))
        assertEquals(200, outcome.response.statusCode)
        assertEquals(RTSPResponder.Effect.StopStreaming, outcome.effect)
        assertEquals(RTSPResponder.State.READY, responder.state)
        assertTrue(outcome.response.headers.any { it.first == "Session" })
    }

    @Test
    fun `PAUSE when not playing is refused`() {
        assertEquals(455, responder().respond(request("PAUSE")).response.statusCode)
    }

    @Test
    fun `TEARDOWN answers and then closes`() {
        val responder = responder()
        setupAndPlay(responder)
        val outcome = responder.respond(request("TEARDOWN", headers = mapOf("cseq" to "7")))
        assertEquals(200, outcome.response.statusCode)
        assertEquals(RTSPResponder.Effect.Close, outcome.effect)
        assertEquals(RTSPResponder.State.INITIAL, responder.state)
    }

    @Test
    fun `GET_PARAMETER with no body is a keepalive`() {
        val responder = responder()
        setupAndPlay(responder)
        val outcome = responder.respond(request("GET_PARAMETER", headers = mapOf("cseq" to "8")))
        assertEquals(200, outcome.response.statusCode)
        assertEquals(RTSPResponder.Effect.None, outcome.effect)
        assertTrue(outcome.response.headers.any { it.first == "Session" })
    }

    @Test
    fun `a request carrying another session's identifier is 454`() {
        val responder = responder()
        setupAndPlay(responder)
        val outcome = responder.respond(
            request("PLAY", headers = mapOf("cseq" to "9", "session" to "deadbeef"))
        )
        assertEquals(454, outcome.response.statusCode)
    }

    @Test
    fun `an unimplemented method is 501`() {
        assertEquals(501, responder().respond(request("RECORD")).response.statusCode)
        assertEquals(501, responder().respond(request("ANNOUNCE")).response.statusCode)
    }

    @Test
    fun `the audio track is not offered when there is no audio`() {
        val responder = RTSPResponder("s", "v=0\r\n", hasAudio = false)
        val outcome = responder.respond(
            request(
                "SETUP",
                uri = "rtsp://host/live/trackID=1",
                headers = mapOf("cseq" to "1", "transport" to "RTP/AVP/TCP;unicast;interleaved=2-3")
            )
        )
        assertEquals(404, outcome.response.statusCode)
    }

    @Test
    fun `the session header carries the timeout a client needs for its keepalive`() {
        val responder = responder()
        val outcome = responder.respond(
            request(
                "SETUP",
                uri = "rtsp://host/live/trackID=0",
                headers = mapOf("cseq" to "1", "transport" to "RTP/AVP/TCP;unicast;interleaved=0-1")
            )
        )
        assertEquals(
            "1234abcd;timeout=${RTSPResponder.sessionTimeout}",
            outcome.response.headers.first { it.first == "Session" }.second
        )
    }

    @Test
    fun `generated session identifiers are long enough to be unguessable`() {
        val identifiers = (1..50).map { RTSPResponder.generateSessionIdentifier() }
        assertEquals(50, identifiers.toSet().size)
        assertTrue(identifiers.all { it.length >= 8 })
    }

    private fun setupAndPlay(responder: RTSPResponder) {
        responder.respond(
            request(
                "SETUP",
                uri = "rtsp://host/live/trackID=0",
                headers = mapOf("cseq" to "3", "transport" to "RTP/AVP/TCP;unicast;interleaved=0-1")
            )
        )
        responder.respond(request("PLAY", headers = mapOf("cseq" to "5")))
    }
}

class SDPBuilderTest {
    private val identity = DeviceIdentity("c94df9ca-d7c2-468f-8529-97d01fba14e7", "Third Base")

    // A minimal but real H.264 SPS/PPS pair: profile_idc 100, constraint 0x00, level_idc 40.
    private val sps = byteArrayOf(0x67, 0x64, 0x00, 0x28, 0x11, 0x22)
    private val pps = byteArrayOf(0x68, 0xCE.toByte(), 0x3C, 0x80.toByte())

    private fun build(codec: StreamCodec = StreamCodec.H264, withAudio: Boolean = true): String =
        SDPBuilder(
            identity = identity,
            video = SDPBuilder.VideoTrack(codec, listOf(sps, pps), 1920, 1080),
            audio = if (withAudio) {
                SDPBuilder.AudioTrack(byteArrayOf(0x11, 0x88.toByte()), 48_000, 1)
            } else {
                null
            },
            videoSSRC = 305419896L,
            audioSSRC = 305419897L
        ).build()

    @Test
    fun `every line is CRLF terminated, which VLC and ffmpeg both require`() {
        val sdp = build()
        assertTrue(sdp.endsWith("\r\n"))
        assertFalse(sdp.replace("\r\n", "").contains("\n"))
    }

    @Test
    fun `the session name is the operator's camera name`() {
        assertTrue(build().contains("s=Third Base\r\n"))
    }

    @Test
    fun `the video track declares H264 at 90 kHz with packetization mode 1`() {
        val sdp = build()
        assertTrue(sdp.contains("m=video 0 RTP/AVP 96\r\n"))
        assertTrue(sdp.contains("a=rtpmap:96 H264/90000\r\n"))
        assertTrue(sdp.contains("a=control:trackID=0\r\n"))
        assertTrue(sdp.contains("packetization-mode=1"))
        assertTrue(sdp.contains("a=framesize:96 1920-1080\r\n"))
    }

    @Test
    fun `profile-level-id agrees with the SPS rather than being invented`() {
        // A client decides whether it can decode the stream at all from this, and it has to be made
        // from the same three bytes the SPS carries.
        assertTrue(build().contains("profile-level-id=640028"))
    }

    @Test
    fun `sprop-parameter-sets is unwrapped base64, SPS then PPS`() {
        val sdp = build()
        val expected = java.util.Base64.getEncoder().encodeToString(sps) + "," +
            java.util.Base64.getEncoder().encodeToString(pps)
        assertTrue(sdp.contains("sprop-parameter-sets=$expected"))
        // A wrapped encoding would split the attribute across two SDP lines.
        assertFalse(expected.contains("\n"))
    }

    @Test
    fun `HEVC uses separate sprop attributes in VPS SPS PPS order`() {
        val sdp = SDPBuilder(
            identity = identity,
            video = SDPBuilder.VideoTrack(
                StreamCodec.HEVC,
                listOf(byteArrayOf(0x40, 0x01), byteArrayOf(0x42, 0x01), byteArrayOf(0x44, 0x01)),
                1920,
                1080
            ),
            audio = null,
            videoSSRC = 1,
            audioSSRC = 2
        ).build()
        assertTrue(sdp.contains("a=rtpmap:96 H265/90000\r\n"))
        val fmtp = sdp.lines().first { it.startsWith("a=fmtp:96") }
        assertTrue(fmtp.indexOf("sprop-vps=") < fmtp.indexOf("sprop-sps="))
        assertTrue(fmtp.indexOf("sprop-sps=") < fmtp.indexOf("sprop-pps="))
    }

    @Test
    fun `the audio track repeats the packetizer's declared field widths`() {
        val sdp = build()
        assertTrue(sdp.contains("m=audio 0 RTP/AVP 97\r\n"))
        assertTrue(sdp.contains("a=rtpmap:97 mpeg4-generic/48000/1\r\n"))
        assertTrue(sdp.contains("mode=AAC-hbr"))
        assertTrue(sdp.contains("sizelength=13"))
        assertTrue(sdp.contains("indexlength=3"))
        assertTrue(sdp.contains("indexdeltalength=3"))
        assertTrue(sdp.contains("config=1188"))
    }

    @Test
    fun `a muted microphone omits the audio section entirely`() {
        // Announced-and-silent leaves a client waiting for packets that never come.
        val sdp = build(withAudio = false)
        assertFalse(sdp.contains("m=audio"))
        assertFalse(sdp.contains("trackID=1"))
    }

    @Test
    fun `both tracks carry the same cname, which is what correlates them with RTCP`() {
        val sdp = build()
        assertTrue(sdp.contains("a=ssrc:305419896 cname:${identity.cname}\r\n"))
        assertTrue(sdp.contains("a=ssrc:305419897 cname:${identity.cname}\r\n"))
        assertTrue(sdp.contains("a=ssrc:305419896 name:Third Base\r\n"))
    }

    @Test
    fun `live capture advertises no seek`() {
        val sdp = build()
        assertTrue(sdp.contains("a=range:npt=now-\r\n"))
        assertTrue(sdp.contains("a=type:broadcast\r\n"))
    }
}

class RTCPWriterTest {
    private val identity = DeviceIdentity("c94df9ca-d7c2-468f-8529-97d01fba14e7", "Third Base")
    private val writer = RTCPWriter(0x12345678L, identity)

    @Test
    fun `the sender report length is in words minus one, counting the header`() {
        val report = writer.senderReport(0L, 0L, 0L, 0L)
        // 4 header + 24 body = 28 bytes = 7 words, so the field reads 6. This is the off-by-one
        // every hand-rolled RTCP writer gets wrong.
        assertEquals(28, report.size)
        assertEquals(6, ((report[2].toInt() and 0xFF) shl 8) or (report[3].toInt() and 0xFF))
        assertEquals(0x80, report[0].toInt() and 0xFF)
        assertEquals(200, report[1].toInt() and 0xFF)
    }

    @Test
    fun `the sender report carries the NTP and RTP pair a receiver needs`() {
        val report = writer.senderReport(0x1122334455667788L, 0xAABBCCDDL, 42L, 4200L)
        assertEquals(0x12, report[4].toInt() and 0xFF)
        assertEquals(0x11, report[8].toInt() and 0xFF)
        assertEquals(0x55, report[12].toInt() and 0xFF)
        assertEquals(0xAA, report[16].toInt() and 0xFF)
        assertEquals(42, ((report[20].toInt() and 0xFF) shl 24) or report[23].toInt())
    }

    @Test
    fun `the SDES chunk carries CNAME, NAME and TOOL and is padded to a word`() {
        val sdes = writer.sourceDescription()
        assertEquals(0x81, sdes[0].toInt() and 0xFF)
        assertEquals(202, sdes[1].toInt() and 0xFF)
        assertEquals(0, sdes.size % 4)

        val declared = (((sdes[2].toInt() and 0xFF) shl 8) or (sdes[3].toInt() and 0xFF)) + 1
        assertEquals(sdes.size / 4, declared)

        val items = parseSDESItems(sdes)
        assertEquals(identity.cname, items[1])
        assertEquals(identity.name, items[2])
        assertEquals("GS Cameraman", items[6])
    }

    @Test
    fun `a chunk already on a word boundary still gets a terminator`() {
        // There must be at least one zero byte after the item list, so a chunk that happens to land
        // on four gets four more rather than none.
        val padded = RTCPWriter(1L, DeviceIdentity("c94df9ca-d7c2-468f-8529-97d01fba14e7", "ab"))
            .sourceDescription()
        assertEquals(0, padded.size % 4)
        assertEquals(0, padded[padded.size - 1].toInt())
    }

    @Test
    fun `an over-long name is truncated on a character boundary`() {
        // A single-byte length field cannot describe more, and truncating mid-UTF-8 would make the
        // item unparseable.
        val long = "é".repeat(300)
        val sdes = RTCPWriter(1L, DeviceIdentity("c94df9ca-d7c2-468f-8529-97d01fba14e7", long))
            .sourceDescription()
        val name = parseSDESItems(sdes)[2]!!
        assertTrue(name.toByteArray(Charsets.UTF_8).size <= 255)
        assertTrue(long.startsWith(name))
    }

    @Test
    fun `a compound packet leads with the report and carries the SDES behind it`() {
        // RFC 3550 6.1: every compound packet must lead with a report and carry a CNAME.
        val compound = writer.compoundPacket(0L, 0L, 0L, 0L)
        assertEquals(200, compound[1].toInt() and 0xFF)
        assertEquals(202, compound[29].toInt() and 0xFF)
    }

    @Test
    fun `NTP time is seconds since 1900 in the upper half`() {
        // 1970-01-01 is 2_208_988_800 seconds after 1900-01-01.
        val ntp = RTCPWriter.ntpTime(0L)
        assertEquals(2_208_988_800L, ntp ushr 32)
        assertEquals(0L, ntp and 0xFFFFFFFFL)

        val half = RTCPWriter.ntpTime(500L)
        assertEquals(2_208_988_800L, half ushr 32)
        assertEquals(0x80000000L, half and 0xFFFFFFFFL)
    }

    private fun parseSDESItems(sdes: ByteArray): Map<Int, String> {
        val items = HashMap<Int, String>()
        var offset = 8 // 4 header + 4 SSRC
        while (offset < sdes.size) {
            val type = sdes[offset].toInt() and 0xFF
            if (type == 0) break
            val length = sdes[offset + 1].toInt() and 0xFF
            items[type] = String(sdes, offset + 2, length, Charsets.UTF_8)
            offset += 2 + length
        }
        return items
    }
}

/**
 * A parsed RTSP response, for the tests that read the wire form back. Kept deliberately small and
 * separate from the server's own types so a bug in `RTSPServerResponse.wireFormat` cannot cancel
 * itself out here.
 */
data class WireReply(val statusCode: Int, val reasonPhrase: String, val headers: Map<String, String>, val body: String) {
    fun header(name: String): String? = headers[name.lowercase()]

    companion object {
        /** One response from the front of [data], or null if it is not all there yet. */
        fun parse(data: ByteArray): Pair<WireReply, Int>? {
            val text = String(data, Charsets.ISO_8859_1)
            val end = text.indexOf("\r\n\r\n")
            if (end < 0) return null
            val head = text.substring(0, end).split("\r\n")
            val status = head[0].split(" ", limit = 3)
            val headers = HashMap<String, String>()
            for (line in head.drop(1)) {
                val colon = line.indexOf(':')
                if (colon > 0) headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
            }
            val length = headers["content-length"]?.toIntOrNull() ?: 0
            val bodyStart = end + 4
            if (data.size < bodyStart + length) return null
            val body = String(data, bodyStart, length, Charsets.UTF_8)
            return WireReply(status[1].toInt(), status.getOrElse(2) { "" }, headers, body) to bodyStart + length
        }

        fun parse(response: RTSPServerResponse): WireReply = parse(response.wireFormat)!!.first
    }
}

class RTSPResponderParameterTest {
    private val sdp = "v=0\r\n"

    private fun responder() = RTSPResponder(sessionIdentifier = "ABCD1234EF", sdp = sdp, hasAudio = true)

    private fun parameterRequest(method: String, body: String, session: String? = null): RTSPServerRequest {
        val headers = hashMapOf("cseq" to "9", "content-type" to "text/parameters")
        if (session != null) headers["session"] = session
        return RTSPServerRequest(method, "rtsp://10.0.0.1/live", headers, body.toByteArray(Charsets.UTF_8))
    }

    private fun responderWithParameters() = RTSPResponder(
        sessionIdentifier = "ABCD1234EF",
        sdp = sdp,
        hasAudio = true
    ) { request ->
        when (request.method to request.body) {
            RTSPResponder.ParameterRequest.Method.GET to "ptz.zoom\r\n" ->
                RTSPResponder.ParameterResponse(body = "ptz.zoom: 3\r\n")
            RTSPResponder.ParameterRequest.Method.SET to "ptz.zoom: 5\r\n" ->
                RTSPResponder.ParameterResponse(body = "ptz.zoom: 5\r\n")
            RTSPResponder.ParameterRequest.Method.SET to "device.cname: x\r\n" ->
                RTSPResponder.ParameterResponse(458, "Parameter Is Read-Only", "device.cname\r\n")
            else -> RTSPResponder.ParameterResponse(451, "Parameter Not Understood", request.body)
        }
    }

    @Test
    fun `OPTIONS advertises SET_PARAMETER, which is what Director probes for`() {
        val outcome = responder().respond(RTSPServerRequest("OPTIONS", "rtsp://10.0.0.1/live", mapOf("cseq" to "1")))
        val public = WireReply.parse(outcome.response).header("public") ?: ""
        for (method in listOf("OPTIONS", "DESCRIBE", "SETUP", "PLAY", "TEARDOWN", "GET_PARAMETER", "SET_PARAMETER")) {
            assertTrue("$method is advertised but not handled", public.contains(method))
        }
    }

    @Test
    fun `GET_PARAMETER with a body answers with parameters`() {
        val outcome = responderWithParameters().respond(parameterRequest("GET_PARAMETER", "ptz.zoom\r\n"))
        val parsed = WireReply.parse(outcome.response)

        assertEquals(200, parsed.statusCode)
        assertEquals("9", parsed.header("cseq"))
        assertEquals("text/parameters", parsed.header("content-type"))
        assertEquals("ptz.zoom: 3\r\n", parsed.body)
        assertEquals(RTSPResponder.Effect.None, outcome.effect)
    }

    @Test
    fun `GET_PARAMETER with a body is not understood without a handler`() {
        val outcome = responder().respond(parameterRequest("GET_PARAMETER", "ptz.zoom\r\n"))
        assertEquals(451, WireReply.parse(outcome.response).statusCode)
    }

    @Test
    fun `SET_PARAMETER needs no session`() {
        val responder = responderWithParameters()
        val outcome = responder.respond(parameterRequest("SET_PARAMETER", "ptz.zoom: 5\r\n"))
        val parsed = WireReply.parse(outcome.response)

        assertEquals(200, parsed.statusCode)
        assertEquals("ptz.zoom: 5\r\n", parsed.body)
        // Server-level parameters carry no session.
        assertNull(parsed.header("session"))
        // A parameter write must not create or move a session.
        assertEquals(RTSPResponder.State.INITIAL, responder.state)
    }

    @Test
    fun `SET_PARAMETER errors keep their status and body`() {
        val responder = responderWithParameters()
        val readOnly = WireReply.parse(responder.respond(parameterRequest("SET_PARAMETER", "device.cname: x\r\n")).response)
        assertEquals(458, readOnly.statusCode)
        assertEquals("Parameter Is Read-Only", readOnly.reasonPhrase)
        assertEquals("device.cname\r\n", readOnly.body)

        val unknown = WireReply.parse(responder.respond(parameterRequest("SET_PARAMETER", "nope: 1\r\n")).response)
        assertEquals(451, unknown.statusCode)
    }

    @Test
    fun `SET_PARAMETER is not implemented without a handler`() {
        val outcome = responder().respond(parameterRequest("SET_PARAMETER", "ptz.zoom: 5\r\n"))
        assertEquals(501, WireReply.parse(outcome.response).statusCode)
    }

    @Test
    fun `an empty SET_PARAMETER is a keepalive`() {
        val outcome = responderWithParameters().respond(parameterRequest("SET_PARAMETER", ""))
        val parsed = WireReply.parse(outcome.response)
        assertEquals(200, parsed.statusCode)
        assertEquals("", parsed.body)
        assertNull(parsed.header("content-type"))
    }

    @Test
    fun `a wrong session still refuses parameters`() {
        val outcome = responderWithParameters().respond(parameterRequest("GET_PARAMETER", "ptz.zoom\r\n", session = "OTHER"))
        assertEquals(454, WireReply.parse(outcome.response).statusCode)
    }
}

/**
 * A parameter exchange shaped exactly as GS Director's `RTSPRequestBuilder` puts it on the wire —
 * request line, `CSeq`, `User-Agent`, `Content-Type`, `Content-Length`, CRLF throughout — parsed by
 * this server's request parser, answered from the vocabulary, and read back the way Director's
 * `RTSPResponse` reads it. The iOS suite runs the same exchange with Director's real code on both
 * ends; the request bytes here are what that builder emits.
 */
class RTSPParameterInteropTest {
    private val uri = "rtsp://192.168.7.118:8554/live/mainstream"
    private var cseq = 1

    /** A responder whose parameters come from a mutable snapshot, the way the phone's do. */
    private class Phone(var snapshot: CameraSnapshot) {
        val responder = RTSPResponder(sessionIdentifier = "S1", sdp = "v=0\r\n", hasAudio = true) { request ->
            val current = snapshot
            when (request.method) {
                RTSPResponder.ParameterRequest.Method.GET ->
                    when (val outcome = CameraParameters.respondToGet(request.body, current)) {
                        is ParameterOutcome.Success -> RTSPResponder.ParameterResponse(body = outcome.value.encoded)
                        is ParameterOutcome.Failure -> refusal(outcome)
                    }
                RTSPResponder.ParameterRequest.Method.SET ->
                    when (val outcome = CameraParameters.parseSet(request.body, current)) {
                        is ParameterOutcome.Success -> {
                            val applied = CameraParameters.snapshot(outcome.value, current)
                            snapshot = applied
                            RTSPResponder.ParameterResponse(body = CameraParameters.echo(outcome.value, applied).encoded)
                        }
                        is ParameterOutcome.Failure -> refusal(outcome)
                    }
            }
        }

        private fun refusal(outcome: ParameterOutcome.Failure) = RTSPResponder.ParameterResponse(
            outcome.error.statusCode, outcome.error.reasonPhrase, outcome.error.body
        )
    }

    /** The bytes Director's builder writes for one request. */
    private fun directorRequest(method: String, body: String? = null, contentType: Boolean = true): ByteArray {
        val text = StringBuilder()
        text.append("$method $uri RTSP/1.0\r\n")
        text.append("CSeq: ${cseq++}\r\n")
        text.append("User-Agent: GS Director/1.0\r\n")
        if (body != null) {
            if (contentType) text.append("Content-Type: text/parameters\r\n")
            text.append("Content-Length: ${body.toByteArray(Charsets.UTF_8).size}\r\n")
        }
        text.append("\r\n")
        return text.toString().toByteArray(Charsets.UTF_8) + (body?.toByteArray(Charsets.UTF_8) ?: ByteArray(0))
    }

    private fun exchange(phone: Phone, request: ByteArray): WireReply {
        val parsed = RTSPServerRequest.parse(request)
        assertNotNull(parsed)
        assertEquals(request.size, parsed!!.consumed)
        return WireReply.parse(phone.responder.respond(parsed.request).response)
    }

    private fun decode(body: String): CameraParameterSet = CameraParameterSet.decode(body).getOrNull()!!

    @Test
    fun `Director asks for everything and rebuilds the phone's state`() {
        val phone = Phone(CameraParametersTest.snapshot())
        val reply = exchange(phone, directorRequest("GET_PARAMETER", "*\r\n"))

        assertEquals(200, reply.statusCode)
        assertEquals("1", reply.header("cseq"))
        assertEquals("text/parameters", reply.header("content-type"))
        val snapshot = CameraParameters.decodeSnapshot(decode(reply.body))
        assertNotNull(snapshot)
        assertEquals(listOf(0.5, 1.0, 3.0, 9.0), snapshot!!.mapping.presetDisplayedZooms)
        assertEquals("Third Base", snapshot.name)
    }

    @Test
    fun `Director writes a zoom and reads the clamped value back`() {
        val phone = Phone(CameraParametersTest.snapshot())
        val reply = exchange(phone, directorRequest("SET_PARAMETER", "ptz.zoom: 12\r\n"))

        assertEquals(200, reply.statusCode)
        val set = decode(reply.body)
        assertEquals(listOf("ptz.zoom"), set.names)
        assertEquals("9", set["ptz.zoom"])

        // The next read sees the write.
        val readBack = exchange(phone, directorRequest("GET_PARAMETER", "ptz.zoom\r\n", contentType = false))
        assertEquals("9", decode(readBack.body)["ptz.zoom"])
    }

    @Test
    fun `a codec change carries its default bitrate, applied as one settings change`() {
        val phone = Phone(CameraParametersTest.snapshot())
        assertEquals(200, exchange(phone, directorRequest("SET_PARAMETER", "videoEncoder.encoding: H264\r\n")).statusCode)

        val read = exchange(
            phone,
            directorRequest("GET_PARAMETER", "videoEncoder.encoding\r\nvideoEncoder.rateControl.bitrateLimit\r\n")
        )
        val set = decode(read.body)
        assertEquals("H264", set["videoEncoder.encoding"])
        assertEquals("6000", set["videoEncoder.rateControl.bitrateLimit"])
    }

    @Test
    fun `errors reach Director with their RTSP status and the offending name`() {
        val phone = Phone(CameraParametersTest.snapshot())

        val readOnly = exchange(phone, directorRequest("SET_PARAMETER", "device.cname: x\r\n"))
        assertEquals(458, readOnly.statusCode)
        assertTrue(readOnly.body.startsWith("device.cname\r\n"))

        val unknown = exchange(phone, directorRequest("GET_PARAMETER", "ptz.tilt\r\n"))
        assertEquals(451, unknown.statusCode)

        val bad = exchange(phone, directorRequest("SET_PARAMETER", "ptz.zoom: 3\r\nvideoEncoder.encoding: AV1\r\n"))
        assertEquals(400, bad.statusCode)
        assertTrue(bad.body.startsWith("videoEncoder.encoding\r\n"))

        // Nothing from the mixed request took.
        val zoom = exchange(phone, directorRequest("GET_PARAMETER", "ptz.zoom\r\n"))
        assertEquals("1", decode(zoom.body)["ptz.zoom"])
    }

    @Test
    fun `an empty GET_PARAMETER is still the keepalive it always was`() {
        val phone = Phone(CameraParametersTest.snapshot())
        val reply = exchange(phone, directorRequest("GET_PARAMETER"))
        assertEquals(200, reply.statusCode)
        assertEquals("", reply.body)
        assertNull(reply.header("content-type"))
    }
}

/**
 * The server over a real loopback socket, with no encoder behind it. What the responder tests
 * cannot settle: that a connection which only polls parameters is not shown as a viewer, and that
 * playing and tearing down move the count.
 *
 * The `Context` is a bare wrapper: with `advertise = false` the server never touches it, and NSD is
 * the one part of this file that needs a device.
 */
class RTSPServerLoopbackTest {
    private val identity = DeviceIdentity("c94df9ca-d7c2-468f-8529-97d01fba14e7", "Loopback")

    private fun startServer(): RTSPServer {
        val server = RTSPServer(
            context = android.content.ContextWrapper(null),
            describe = { _, _ -> "v=0\r\n" },
            hasAudio = { false },
            identity = { identity },
            requestKeyframe = {}
        ) { request ->
            when (request.method) {
                RTSPResponder.ParameterRequest.Method.GET -> RTSPResponder.ParameterResponse(body = "ptz.zoom: 1\r\n")
                RTSPResponder.ParameterRequest.Method.SET -> RTSPResponder.ParameterResponse(body = request.body)
            }
        }
        server.start(port = 0, fallbackPort = 0, path = "/live/mainstream", advertise = false)
        assertNotNull("the listener never became ready", server.currentStatus().port)
        return server
    }

    private fun waitUntil(seconds: Double = 2.0, condition: () -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + (seconds * 1000).toLong()
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return true
            Thread.sleep(25)
        }
        return condition()
    }

    /** The least client that can hold a socket open and read one response per request. */
    private class LoopbackClient(port: Int) : AutoCloseable {
        private val socket = Socket("127.0.0.1", port).apply {
            soTimeout = 3_000
            tcpNoDelay = true
        }
        private val input = socket.getInputStream()
        private var buffer = ByteArray(0)

        fun exchange(text: String): WireReply {
            socket.getOutputStream().apply {
                write(text.toByteArray(Charsets.UTF_8))
                flush()
            }
            val chunk = ByteArray(64 * 1024)
            while (true) {
                WireReply.parse(buffer)?.let { (reply, consumed) ->
                    buffer = buffer.copyOfRange(consumed, buffer.size)
                    return reply
                }
                val read = input.read(chunk)
                if (read < 0) throw EOFException("the server closed the connection")
                buffer += chunk.copyOf(read)
            }
        }

        override fun close() = socket.close()
    }

    @Test
    fun `a control-only connection is accepted but is not a viewer`() {
        val server = startServer()
        try {
            val port = server.currentStatus().port!!
            LoopbackClient(port).use { client ->
                val options = client.exchange("OPTIONS rtsp://127.0.0.1/live/mainstream RTSP/1.0\r\nCSeq: 1\r\n\r\n")
                assertEquals(200, options.statusCode)
                assertTrue(options.header("public")?.contains("SET_PARAMETER") == true)

                val answer = client.exchange(
                    "GET_PARAMETER rtsp://127.0.0.1/live/mainstream RTSP/1.0\r\nCSeq: 2\r\n" +
                        "Content-Type: text/parameters\r\nContent-Length: 10\r\n\r\nptz.zoom\r\n"
                )
                assertEquals(200, answer.statusCode)
                assertEquals("ptz.zoom: 1\r\n", answer.body)

                assertTrue(waitUntil { server.currentStatus().acceptedClients == 1 })
                // Polling parameters is not watching the stream.
                assertEquals(0, server.currentStatus().clientCount)
            }
        } finally {
            server.stop()
        }
    }

    @Test
    fun `a playing session is a viewer until it tears down`() {
        val server = startServer()
        try {
            val port = server.currentStatus().port!!
            LoopbackClient(port).use { client ->
                val setup = client.exchange(
                    "SETUP rtsp://127.0.0.1/live/mainstream/${SDPBuilder.videoTrackControl} RTSP/1.0\r\nCSeq: 1\r\n" +
                        "Transport: RTP/AVP/TCP;unicast;interleaved=0-1\r\n\r\n"
                )
                assertEquals(200, setup.statusCode)
                val session = setup.header("session")!!.substringBefore(";")
                assertEquals(0, server.currentStatus().clientCount)

                val play = client.exchange(
                    "PLAY rtsp://127.0.0.1/live/mainstream RTSP/1.0\r\nCSeq: 2\r\nSession: $session\r\n\r\n"
                )
                assertEquals(200, play.statusCode)
                assertTrue("PLAY did not register a viewer", waitUntil { server.currentStatus().clientCount == 1 })

                val teardown = client.exchange(
                    "TEARDOWN rtsp://127.0.0.1/live/mainstream RTSP/1.0\r\nCSeq: 3\r\nSession: $session\r\n\r\n"
                )
                assertEquals(200, teardown.statusCode)
                assertTrue("TEARDOWN left the viewer counted", waitUntil { server.currentStatus().clientCount == 0 })
                assertTrue(waitUntil { server.currentStatus().closedClients == 1 })
            }
        } finally {
            server.stop()
        }
    }
}
