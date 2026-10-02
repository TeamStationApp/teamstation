package app.teamstation.cameraman.harness

import app.teamstation.cameraman.rtsp.RTSPServer
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket

/**
 * An HTTP front door for the commands in [ControlChannel].
 *
 * 8766 rather than Producer's 8765, so both apps can be driven from one script during the
 * end-to-end run without either having to move. `adb forward tcp:8766 tcp:8766` puts it on the Mac's
 * loopback, so `scripts/control.js` drives this build with the same arguments it drives the iOS one.
 *
 * Only started when the app was launched for UI testing. Nothing here runs in a normal session.
 */
class ControlServer(
    val port: Int = defaultPort,
    /** Returns a JSON body for the request, or null if the command was refused. */
    private val handler: (String) -> ByteArray?
) {
    private var listener: ServerSocket? = null
    private var thread: Thread? = null

    fun start() {
        if (listener != null) return
        val socket = ServerSocket().apply {
            reuseAddress = true
            bind(InetSocketAddress(port))
        }
        listener = socket
        thread = Thread({
            while (!socket.isClosed) {
                val client = runCatching { socket.accept() }.getOrNull() ?: return@Thread
                // One connection at a time is plenty: a control channel serves one script.
                runCatching { serve(client) }
                runCatching { client.close() }
            }
        }, "cameraman-control").apply {
            isDaemon = true
            start()
        }
    }

    fun stop() {
        runCatching { listener?.close() }
        listener = null
        thread = null
    }

    private fun serve(client: Socket) {
        client.soTimeout = 5_000
        val input = client.getInputStream()
        val head = StringBuilder()
        val chunk = ByteArray(1024)
        // Only the request line matters; a blank line marks the end of the headers.
        while (!head.contains("\r\n\r\n") && !head.contains("\n\n")) {
            val read = input.read(chunk)
            if (read <= 0) return
            head.append(String(chunk, 0, read, Charsets.UTF_8))
            if (head.length > 8 * 1024) return
        }

        val target = requestTarget(head.toString())
        val body: ByteArray
        val status: String

        if (target == "/" || target == "/health") {
            body = """{"ok":true}""".toByteArray(Charsets.UTF_8)
            status = "200 OK"
        } else {
            val url = "${ControlChannel.scheme}://test$target"
            val result = handler(url)
            if (result != null) {
                body = result
                status = "200 OK"
            } else {
                // A typo and a command the app refused are different problems, and reporting both as
                // "unknown command" sends you looking for a parsing bug that is not there.
                val parsed = ControlChannel.command(url) != null
                val reason = if (parsed) {
                    "command rejected — the app was not in a state to run it"
                } else {
                    "unknown command"
                }
                body = """{"ok":false,"error":"$reason"}""".toByteArray(Charsets.UTF_8)
                status = "400 Bad Request"
            }
        }

        val header = listOf(
            "HTTP/1.1 $status",
            "Content-Type: application/json",
            "Content-Length: ${body.size}",
            "Connection: close",
            "",
            ""
        ).joinToString("\r\n")

        val output = client.getOutputStream()
        output.write(header.toByteArray(Charsets.UTF_8))
        output.write(body)
        output.flush()
    }

    companion object {
        const val defaultPort = 8766

        /** `GET /set-zoom?displayed=2 HTTP/1.1` reduced to `/set-zoom?displayed=2`. */
        fun requestTarget(head: String): String =
            head.split("\n").firstOrNull()
                ?.split(" ")
                ?.getOrNull(1)
                ?: "/"

        /** The addresses a script can reach this listener on, for the state dump. */
        fun localAddresses(): List<String> = RTSPServer.localAddresses()
    }
}
