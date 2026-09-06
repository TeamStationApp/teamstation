package co.gamestation.cameraman.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import co.gamestation.cameraman.capture.FormatCatalogue
import co.gamestation.cameraman.core.StreamCodec
import co.gamestation.cameraman.engine.AppEnvironment
import co.gamestation.cameraman.ui.theme.MonospaceLabel
import java.util.Locale

/**
 * Name, codec, format and bitrate.
 *
 * Opening this must not touch the pipeline; only Done applies, and only when something actually
 * changed. A reconfigure that fires because the operator wanted to read the URL would look like the
 * camera glitching.
 *
 * Two columns because the app is landscape-only. A single list on a 411dp-tall window puts
 * everything below the bitrate off the bottom, and a settings screen whose settings have to be
 * scrolled for is one whose settings do not get found — which is not a guess: the resolution list
 * was inline once, and the microphone toggle and the camera's identifier were both unreachable.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(environment: AppEnvironment, onDone: () -> Unit) {
    val context = LocalContext.current
    val identity by environment.identity.collectAsStateWithLifecycle()
    val serverStatus by environment.serverStatus.collectAsStateWithLifecycle()

    var draftName by remember { mutableStateOf(identity.name) }
    var draft by remember { mutableStateOf(environment.settings.value.copy()) }
    var didCopyURL by remember { mutableStateOf(false) }

    val options = remember(environment.formatOptions, draft.width, draft.height, draft.frameRate) {
        // The catalogue is empty until the camera has been configured, and a picker with no options
        // cannot show what is currently selected. Falling back to the current settings keeps the row
        // honest before the first frame.
        environment.formatOptions.ifEmpty {
            listOf(FormatCatalogue.Option(draft.width, draft.height, draft.frameRate, true))
        }
    }
    val selected = options.firstOrNull {
        it.width == draft.width && it.height == draft.height && it.frameRate == draft.frameRate
    }

    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text("Camera", style = MaterialTheme.typography.titleLarge) },
                actions = {
                    TextButton(
                        onClick = {
                            val trimmed = draftName.trim()
                            if (trimmed != identity.name) environment.rename(trimmed)
                            if (draft != environment.settings.value) {
                                environment.updateSettings(draft)
                                environment.applySettings()
                            }
                            onDone()
                        },
                        modifier = Modifier.testTag("settings-done")
                    ) {
                        Text("Done", style = MaterialTheme.typography.labelLarge)
                    }
                },
                colors = TopAppBarDefaults.centerAlignedTopAppBarColors(
                    containerColor = MaterialTheme.colorScheme.surfaceContainerLowest
                )
            )
        },
        containerColor = MaterialTheme.colorScheme.background
    ) { padding ->
        Row(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 16.dp, vertical = 4.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Column(
                modifier = Modifier
                    .weight(1f)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                StreamCard(environment, serverStatus, didCopyURL) {
                    val clipboard =
                        context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                    clipboard?.setPrimaryClip(ClipData.newPlainText("rtsp", environment.streamURL))
                    didCopyURL = true
                }

                NameCard(
                    draftName = draftName,
                    onNameChange = { draftName = it },
                    identifier = identity.cname
                )
            }

            Column(
                modifier = Modifier
                    .weight(1f)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                VideoCard(
                    draft = draft,
                    options = options,
                    selected = selected,
                    onDraftChange = { draft = it }
                )
                AudioCard(
                    audioEnabled = draft.audioEnabled,
                    onAudioChange = { draft = draft.copy(audioEnabled = it) }
                )
            }
        }
    }
}

@Composable
private fun SettingsCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainer
        ),
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(modifier = Modifier.padding(vertical = 6.dp)) {
            Text(
                text = title.uppercase(Locale.US),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 2.dp, bottom = 2.dp)
            )
            content()
        }
    }
}

@Composable
private fun StreamCard(
    environment: AppEnvironment,
    serverStatus: co.gamestation.cameraman.rtsp.RTSPServer.Status,
    didCopyURL: Boolean,
    onCopy: () -> Unit
) {
    SettingsCard("Stream") {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onCopy)
                .padding(horizontal = 16.dp, vertical = 6.dp)
                .testTag("settings-url")
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    "Address",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    environment.streamURL,
                    style = MonospaceLabel,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
            Icon(
                imageVector = if (didCopyURL) Icons.Filled.Check else Icons.Filled.ContentCopy,
                contentDescription = "Copy stream address",
                tint = if (didCopyURL) {
                    MaterialTheme.colorScheme.tertiary
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
                modifier = Modifier
                    .size(20.dp)
                    .testTag("settings-url-copy")
            )
        }

        if (serverStatus.usedFallbackPort) {
            // Not a warning, a fact: Android refuses port 554 to an unprivileged process, so an
            // operator reading "554" off the iOS build next to this one needs to know why the two
            // differ before they type the wrong address into Producer.
            Text(
                "Port ${serverStatus.requestedPort} is privileged on Android; " +
                    "serving on ${serverStatus.port}.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier
                    .padding(horizontal = 16.dp)
                    .testTag("settings-port-note")
            )
        }

        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)

        ValueRow("Clients", serverStatus.clientCount.toString(), "settings-clients")
        ValueRow(
            "Discovery",
            if (serverStatus.isAdvertising) "advertising" else "not advertising",
            "settings-advertising"
        )
    }
}

@Composable
private fun NameCard(draftName: String, onNameChange: (String) -> Unit, identifier: String) {
    SettingsCard("Name") {
        OutlinedTextField(
            value = draftName,
            onValueChange = onNameChange,
            singleLine = true,
            label = { Text("Camera name") },
            // Worth saying here rather than in a line of its own, because the obvious assumption is
            // the opposite — that renaming a camera is what makes it a different camera — and this
            // is the field where that assumption gets acted on.
            supportingText = { Text("Renaming keeps this camera's identity.") },
            textStyle = MaterialTheme.typography.bodyLarge,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .testTag("settings-name-field")
        )
        ValueRow("Identifier", identifier, "settings-cname")
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun VideoCard(
    draft: co.gamestation.cameraman.core.StreamSettings,
    options: List<FormatCatalogue.Option>,
    selected: FormatCatalogue.Option?,
    onDraftChange: (co.gamestation.cameraman.core.StreamSettings) -> Unit
) {
    SettingsCard("Video") {
        // A segmented button is M3's component for a small, mutually exclusive choice, which is
        // exactly what two codecs are — a pair of chips would suggest they could both be on.
        SingleChoiceSegmentedButtonRow(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 4.dp)
        ) {
            StreamCodec.entries.forEachIndexed { index, codec ->
                SegmentedButton(
                    selected = draft.codec == codec,
                    onClick = { onDraftChange(draft.copy().apply { selectCodec(codec) }) },
                    shape = SegmentedButtonDefaults.itemShape(index, StreamCodec.entries.size),
                    modifier = Modifier.testTag("settings-codec-${codec.rawValue}")
                ) {
                    Text(codec.displayName)
                }
            }
        }

        // A menu rather than the whole list inline. A handset reports dozens of capture sizes — this
        // Pixel starts at 176x144 — and rendering them all pushed the bitrate, the microphone toggle
        // and the identifier off the bottom of a landscape screen.
        var isPickingFormat by remember { mutableStateOf(false) }
        ExposedDropdownMenuBox(
            expanded = isPickingFormat,
            onExpandedChange = { isPickingFormat = it },
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)
        ) {
            OutlinedTextField(
                value = selected?.label
                    ?: "${draft.width}x${draft.height} @ ${draft.frameRate.toInt()}",
                onValueChange = {},
                readOnly = true,
                label = { Text("Resolution") },
                supportingText = selected?.annotation?.let {
                    { Text(it, modifier = Modifier.testTag("settings-format-note")) }
                },
                trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = isPickingFormat) },
                modifier = Modifier
                    .menuAnchor(androidx.compose.material3.MenuAnchorType.PrimaryNotEditable)
                    .fillMaxWidth()
                    .testTag("settings-format")
            )
            ExposedDropdownMenu(
                expanded = isPickingFormat,
                onDismissRequest = { isPickingFormat = false }
            ) {
                for (option in options) {
                    DropdownMenuItem(
                        text = { Text(option.label) },
                        trailingIcon = option.annotation?.let {
                            {
                                Text(
                                    it,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        },
                        onClick = {
                            onDraftChange(
                                draft.copy(
                                    width = option.width,
                                    height = option.height,
                                    frameRate = option.frameRate
                                )
                            )
                            isPickingFormat = false
                        },
                        modifier = Modifier.testTag("settings-format-${option.label}")
                    )
                }
            }
        }

        Column(modifier = Modifier.padding(horizontal = 16.dp)) {
            Text(
                String.format(Locale.US, "Bitrate  %.1f Mbps", draft.bitrate / 1_000_000.0),
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.testTag("settings-bitrate-value")
            )
            // Continuous rather than stepped: Material 3 draws a tick for every step, and 97 of
            // them turned the track into a dotted line that read as a progress bar. The half-megabit
            // granularity the iOS build steps in is kept by rounding the value instead.
            Slider(
                value = (draft.bitrate / 1_000_000.0).toFloat(),
                onValueChange = { mbps ->
                    val rounded = (Math.round(mbps * 2f) / 2.0)
                    onDraftChange(draft.copy(bitrate = (rounded * 1_000_000).toInt()))
                },
                valueRange = 1f..50f,
                // The default inactive track is `surfaceContainerHighest`, which against this card's
                // `surfaceContainer` is very nearly the same colour — the track vanished and the
                // control read as a stray dot. Naming the roles explicitly is the theming answer.
                colors = SliderDefaults.colors(
                    thumbColor = MaterialTheme.colorScheme.primary,
                    activeTrackColor = MaterialTheme.colorScheme.primary,
                    inactiveTrackColor = MaterialTheme.colorScheme.outlineVariant
                ),
                modifier = Modifier.testTag("settings-bitrate")
            )
        }
    }
}

@Composable
private fun AudioCard(audioEnabled: Boolean, onAudioChange: (Boolean) -> Unit) {
    SettingsCard("Audio") {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 2.dp)
        ) {
            Text(
                "Microphone",
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f)
            )
            Switch(
                checked = audioEnabled,
                onCheckedChange = onAudioChange,
                modifier = Modifier.testTag("settings-audio")
            )
        }
    }
}

/**
 * A label and a value on one line.
 *
 * Not a `ListItem`: that component has a 56dp minimum height by specification, and six of them do
 * not fit in a 411dp-tall landscape window alongside a text field and a card of video settings.
 * Built from the same theme roles and type scale, so it still reads as part of the same list.
 */
@Composable
private fun ValueRow(label: String, value: String, testTag: String) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 7.dp)
    ) {
        Text(
            label,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1f)
        )
        Text(
            value,
            style = MonospaceLabel,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.testTag(testTag)
        )
    }
}

/**
 * `ListItem` defaults to `surface`, which would draw a slab inside the card it already sits in.
 * Clearing the container lets the card's own colour show through, which is what M3 expects of a list
 * inside a container.
 */
@Composable
private fun transparentListItem() = ListItemDefaults.colors(
    containerColor = androidx.compose.ui.graphics.Color.Transparent
)
