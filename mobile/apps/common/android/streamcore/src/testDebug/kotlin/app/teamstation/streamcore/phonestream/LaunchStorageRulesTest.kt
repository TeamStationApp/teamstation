package app.teamstation.streamcore.phonestream

import org.junit.Assert.assertEquals
import org.junit.Test

class LaunchStorageRulesTest {
    @Test
    fun `a debug build takes the start floor from its property and keeps the stop floor`() {
        val asked = mutableListOf<String>()
        val rules = launchStorageRules { name -> asked += name; " 123456 " }
        assertEquals(listOf("debug.ts.phone.start_floor"), asked)
        assertEquals(123_456L, rules.startFloorBytes)
        assertEquals(PhoneStorageRules.standard.stopFloorBytes, rules.stopFloorBytes)
    }

    @Test
    fun `a property that is unset or not a number leaves the standard rules`() {
        for (value in listOf(null, "", "lots")) {
            assertEquals(PhoneStorageRules.standard, launchStorageRules { value })
        }
    }

    @Test
    fun `the JVM has no system properties to read`() {
        assertEquals(PhoneStorageRules.standard, launchStorageRules())
    }
}
