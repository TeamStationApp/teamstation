package app.teamstation.cameraman

import app.teamstation.cameraman.rtsp.RTSPServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AdvertisedAddressTest {
    @Test
    fun `cellular is never advertised, even when it is the only address left`() {
        assertNull(RTSPServer.preferredLANIPv4(listOf("rmnet_data1" to "48.146.19.16")))
        assertNull(RTSPServer.preferredLANIPv4(listOf("rmnet_data1" to "10.44.2.9")))
        assertNull(RTSPServer.preferredLANIPv4(listOf("v4-rmnet_data1" to "192.0.0.4")))
        assertEquals(
            "10.10.7.226",
            RTSPServer.preferredLANIPv4(listOf("rmnet_data1" to "48.146.19.16", "wlan0" to "10.10.7.226"))
        )
    }

    @Test
    fun `a public or carrier address on Wi-Fi is not offered either`() {
        assertNull(RTSPServer.preferredLANIPv4(listOf("wlan0" to "100.64.3.3")))
        assertEquals("172.20.0.9", RTSPServer.preferredLANIPv4(listOf("wlan0" to "172.20.0.9")))
    }
}
