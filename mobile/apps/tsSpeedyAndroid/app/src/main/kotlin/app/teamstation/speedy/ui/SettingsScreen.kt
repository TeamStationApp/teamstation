package app.teamstation.speedy.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.teamstation.speedy.core.RadarStatus
import app.teamstation.speedy.core.SpeedyModel

private val Secondary = Color.White.copy(alpha = 0.6f)
private val Accent = Color(0xFF0A84FF)
private val Destructive = Color(0xFFFF453A)

/** Settings holds one thing: pairing the radar. */
@Composable
fun SettingsScreen(model: SpeedyModel, onAllowBluetooth: () -> Unit) {
    val status by model.radarStatus.collectAsState()
    BackHandler { model.closeSettings() }
    Box(Modifier.fillMaxSize().background(Color.Black).safeDrawingPadding()) {
        Column(Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp)) {
                Text(
                    "Settings",
                    color = Color.White,
                    fontSize = 17.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.align(Alignment.Center)
                )
                TextButton(onClick = model::closeSettings, modifier = Modifier.align(Alignment.CenterEnd).testTag("settings-done")) {
                    Text("Done", color = Accent, fontSize = 17.sp)
                }
            }
            Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp)) {
                RadarCard(status, model, onAllowBluetooth)
            }
        }
    }
}

@Composable
fun RadarCard(status: RadarStatus, model: SpeedyModel, onAllowBluetooth: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().background(Color(0xFF1C1C1E), RoundedCornerShape(14.dp)).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Text("Radar", color = Color.White, fontSize = 17.sp, fontWeight = FontWeight.SemiBold)
        Text("Pair a TAG One to show and speak its pitch and exit speeds.", color = Secondary, fontSize = 13.sp)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Status", color = Color.White, fontSize = 17.sp)
            Text(status.text, color = Secondary, fontSize = 17.sp, modifier = Modifier.testTag("settings-radar-status"))
        }
        if (status.blocker == RadarStatus.Blocker.PERMISSION || status.blocker == RadarStatus.Blocker.PERMISSION_IN_SETTINGS) {
            TextButton(onClick = onAllowBluetooth, modifier = Modifier.testTag("settings-radar-allow")) {
                val label = if (status.blocker == RadarStatus.Blocker.PERMISSION) "Allow Bluetooth" else "Open Settings"
                Text(label, color = Accent, fontSize = 17.sp)
            }
        }
        status.serial?.let { serial ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(serial, color = Color.White, fontSize = 17.sp, modifier = Modifier.testTag("settings-radar-serial"))
                status.batteryPercent?.let {
                    Text("⚡$it%", color = Secondary, fontSize = 17.sp, modifier = Modifier.testTag("settings-radar-battery"))
                }
            }
            TextButton(onClick = model::unpair, modifier = Modifier.testTag("settings-radar-unpair")) {
                Text("Unpair", color = Destructive, fontSize = 17.sp)
            }
        }
        if (status.pairing) {
            if (status.nearby.isEmpty()) {
                Text("No radars in range", color = Secondary, fontSize = 17.sp, modifier = Modifier.testTag("settings-radar-none"))
            }
            for (name in status.nearby) {
                TextButton(onClick = { model.pair(name) }, modifier = Modifier.testTag("settings-radar-option-$name")) {
                    Text(name, color = Accent, fontSize = 17.sp)
                }
            }
            TextButton(onClick = model::stopPairing, modifier = Modifier.testTag("settings-radar-close")) {
                Text("Close", color = Accent, fontSize = 17.sp)
            }
        } else {
            TextButton(onClick = model::startPairing, modifier = Modifier.testTag("settings-radar-pair")) {
                // One radar at a time: pairing another replaces the one paired now.
                Text(if (status.isPaired) "Replace radar" else "Pair", color = Accent, fontSize = 17.sp)
            }
        }
    }
}
