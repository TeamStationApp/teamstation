package co.gamestation.cameraman.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import kotlinx.coroutines.delay
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.semantics.text
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import co.gamestation.cameraman.radar.ConnectionLabel
import co.gamestation.cameraman.radar.RadarPhase
import co.gamestation.cameraman.radar.RadarUiState
import co.gamestation.cameraman.ui.theme.MonospaceLabel

@Composable
fun RadarSettingsCard(
    state: RadarUiState,
    onPair: () -> Unit,
    onUnpair: () -> Unit,
    onChoose: (String) -> Unit,
    onDismiss: () -> Unit,
    onStep: (Int) -> Unit = {},
    onEnabled: (Boolean) -> Unit = {}
) {
    LaunchedEffect(state.phase, state.linkSuppressed) {
        if (state.phase != RadarPhase.connecting || state.linkSuppressed) return@LaunchedEffect
        var step = 0
        while (true) {
            onStep(step)
            step = (step + 1) % 3
            delay(400)
        }
    }
    Card(
        shape = androidx.compose.foundation.shape.RoundedCornerShape(24.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
        modifier = Modifier.fillMaxWidth()
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 20.dp, end = 12.dp, top = 16.dp)
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = "RADAR",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary
                )
                Text(
                    "Proximity hardware sensor",
                    style = MaterialTheme.typography.bodyMedium
                )
            }
            Switch(
                checked = state.enabled,
                onCheckedChange = onEnabled,
                modifier = Modifier.testTag("settings-radar-enabled")
            )
        }
        if (state.showsPair) {
            TextButton(onClick = onPair, modifier = Modifier.testTag("settings-radar-pair")) {
                Text("Pair")
            }
        } else {
            Text(
                text = state.serial.orEmpty(),
                style = MonospaceLabel,
                modifier = Modifier
                    .padding(horizontal = 16.dp, vertical = 4.dp)
                    .testTag("settings-radar-serial")
            )
            val status = when (state.phase) {
                RadarPhase.connecting -> ConnectionLabel.connecting(state.connectingStep)
                RadarPhase.connected -> "Connected"
                RadarPhase.bluetoothOff -> "Bluetooth is off"
                RadarPhase.locationOff -> "Location is off"
                RadarPhase.permission -> "Bluetooth permission is required"
                RadarPhase.idle -> state.statusText
            }
            if (status != null) {
                Text(
                    text = status,
                    color = if (state.phase == RadarPhase.connected) {
                        MaterialTheme.colorScheme.tertiary
                    } else {
                        MaterialTheme.colorScheme.onSurface
                    },
                    modifier = Modifier
                        .padding(horizontal = 16.dp)
                        .testTag("settings-radar-status")
                )
            }
            if (state.readoutText != null) {
                RadarReadout(
                    state,
                    Modifier
                        .padding(horizontal = 16.dp, vertical = 4.dp)
                        .testTag("settings-radar-speeds")
                )
            }
            TextButton(onClick = onUnpair, modifier = Modifier.testTag("settings-radar-unpair")) {
                Text("Unpair", color = MaterialTheme.colorScheme.error)
            }
        }
    }

    if (state.pickerOpen) {
        AlertDialog(
            onDismissRequest = onDismiss,
            modifier = Modifier
                .semantics { testTagsAsResourceId = true }
                .testTag("settings-radar-picker"),
            title = { Text("Pair radar") },
            text = {
                if (state.pickerNames.isEmpty()) {
                    Text("No radars in range")
                } else {
                    androidx.compose.foundation.layout.Column {
                        for (name in state.pickerNames) {
                            TextButton(
                                onClick = { onChoose(name) },
                                modifier = Modifier.testTag("settings-radar-option-$name")
                            ) {
                                Text(name)
                            }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(onClick = onDismiss) { Text("Close") }
            }
        )
    }
}

@Composable
internal fun SpeedPairText(speeds: String, modifier: Modifier = Modifier) {
    val parts = speeds.split("/")
    androidx.compose.foundation.layout.Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier.semantics { text = AnnotatedString(speeds) }
    ) {
        SpeedSide(parts.getOrElse(0) { "–" })
        Text("/")
        SpeedSide(parts.getOrElse(1) { "–" })
    }
}

@Composable
private fun SpeedSide(token: String) {
    Box(modifier = Modifier.height(24.dp), contentAlignment = Alignment.Center) {
        if (token == "–") {
            Box(
                modifier = Modifier
                    .height(2.dp)
                    .width(14.dp)
                    .background(MaterialTheme.colorScheme.onSurface)
            )
        } else {
            Text(token, style = MaterialTheme.typography.titleMedium)
        }
    }
}

@Composable
internal fun RadarReadout(state: RadarUiState, modifier: Modifier = Modifier) {
    val readout = state.readoutText ?: return
    val speeds = state.speedsText ?: return
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier.semantics { text = AnnotatedString(readout) }
    ) {
        if (state.batteryPercent != null) {
            Text(
                "⚡${state.batteryPercent}%",
                style = MaterialTheme.typography.titleMedium
            )
            Spacer(Modifier.width(8.dp))
        }
        SpeedPairText(speeds, Modifier.padding(0.dp))
    }
}

@Composable
fun SpeedOverlay(state: RadarUiState, modifier: Modifier = Modifier) {
    if (state.readoutText == null) return
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.scrim.copy(alpha = 0.55f)
        ),
        modifier = modifier
    ) {
        RadarReadout(
            state,
            Modifier
                .padding(horizontal = 12.dp, vertical = 8.dp)
                .testTag("radar-speeds")
        )
    }
}
