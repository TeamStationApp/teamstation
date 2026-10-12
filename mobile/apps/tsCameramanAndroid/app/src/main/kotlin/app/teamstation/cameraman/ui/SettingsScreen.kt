package app.teamstation.cameraman.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.RangeSlider
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.teamstation.streamcore.capture.FormatCatalogue
import app.teamstation.streamcore.core.CameraLens
import app.teamstation.streamcore.core.LensSelection
import app.teamstation.streamcore.core.ThermalBadgeLevel
import app.teamstation.streamcore.core.StreamCodec
import app.teamstation.cameraman.engine.AppEnvironment
import app.teamstation.cameraman.ui.theme.MonospaceLabel
import java.util.Locale

private val SettingsMint = darkColorScheme(
    primary = Color(0xFF80D99B),
    onPrimary = Color(0xFF00391B),
    primaryContainer = Color(0xFF005229),
    onPrimaryContainer = Color(0xFF9DF7B5),
    secondary = Color(0xFFB3CCB9),
    onSecondary = Color(0xFF00391B),
    secondaryContainer = Color(0xFF384B3E),
    onSecondaryContainer = Color(0xFFB3CCB9),
    tertiary = Color(0xFFA2CED9),
    onTertiary = Color(0xFF00391B),
    error = Color(0xFFFFB4AB),
    onError = Color(0xFF690005),
    background = Color(0xFF121316),
    onBackground = Color(0xFFE2E2E6),
    surface = Color(0xFF121316),
    onSurface = Color(0xFFE2E2E6),
    surfaceVariant = Color(0xFF2A2B30),
    onSurfaceVariant = Color(0xFFC4C6CF),
    surfaceContainerLowest = Color(0xFF0D0E10),
    surfaceContainerLow = Color(0xFF1A1B1E),
    surfaceContainer = Color(0xFF202125),
    surfaceContainerHigh = Color(0xFF2A2B30),
    surfaceContainerHighest = Color(0xFF35363B),
    outline = Color(0xFF8E9099),
    outlineVariant = Color(0xFF44474F)
)

/**
 * Name, codec, format and bitrate.
 *
 * Opening this must not touch the pipeline; only Done applies, and only when something actually
 * changed. A reconfigure that fires because the operator wanted to read the URL would look like the
 * camera glitching.
 *
 * Landscape keeps two columns: video, audio and the name on the left, lenses, the stream and the
 * radar on the right. Portrait stacks one column, alternating those: account, video, lenses,
 * audio, stream, name, radar, scoreboard. The cards follow the settings design: round containers,
 * a mint primary, and the same test tags the flows already look for.
 *
 * A single list on a 411dp-tall window put everything below the bitrate off the bottom — the
 * resolution list was inline once, and the microphone toggle and the camera's identifier were both
 * unreachable. The two columns sit in one scroll, so a swipe moves both of them and the name and
 * the stream stay a short scroll from the top.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(environment: AppEnvironment, onDone: () -> Unit) {
    val context = LocalContext.current
    val identity by environment.identity.collectAsStateWithLifecycle()
    val serverStatus by environment.serverStatus.collectAsStateWithLifecycle()
    val lensCatalog by environment.lensCatalog.collectAsStateWithLifecycle()
    val radar by environment.radarState.collectAsStateWithLifecycle()
    val scoreboard by environment.scoreboard.state.collectAsStateWithLifecycle()

    var draftName by remember { mutableStateOf(identity.name) }
    var draft by remember { mutableStateOf(environment.settings.value.copy()) }
    var didCopyURL by remember { mutableStateOf(false) }

    val options = remember(environment.formatOptions, draft.width, draft.height, draft.frameRate) {
        // The menu plus, when it is missing from the menu, the current setting. The catalogue is
        // empty until the camera has been configured, and a setting that arrived by launch argument
        // or from an earlier build need not be one the menu offers; the row shows what is streaming
        // either way.
        val offered = environment.formatOptions
        val isOffered = offered.any {
            it.width == draft.width && it.height == draft.height && it.frameRate == draft.frameRate
        }
        if (isOffered) offered
        else offered + FormatCatalogue.Option(draft.width, draft.height, draft.frameRate, true)
    }
    val selected = options.firstOrNull {
        it.width == draft.width && it.height == draft.height && it.frameRate == draft.frameRate
    }

    val type = MaterialTheme.typography
    MaterialTheme(colorScheme = SettingsMint, typography = type) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(
                            "Camera",
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Bold
                        )
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(
                                Modifier
                                    .size(6.dp)
                                    .background(MaterialTheme.colorScheme.primary, CircleShape)
                            )
                            Spacer(Modifier.width(6.dp))
                            Text(
                                identity.name + " · " +
                                    if (serverStatus.isListening) "Streaming" else "Standby",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                },
                actions = {
                    if (serverStatus.isListening) {
                        Text(
                            "RTSP Active",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier
                                .padding(end = 8.dp)
                                .background(
                                    MaterialTheme.colorScheme.surfaceContainer,
                                    CircleShape
                                )
                                .border(
                                    1.dp,
                                    MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f),
                                    CircleShape
                                )
                                .padding(horizontal = 12.dp, vertical = 6.dp)
                        )
                    }
                    Button(
                        onClick = {
                            val trimmed = draftName.trim()
                            if (trimmed != identity.name) environment.rename(trimmed)
                            if (draft != environment.settings.value) {
                                environment.updateSettings(draft)
                                environment.applySettings()
                            }
                            onDone()
                        },
                        shape = CircleShape,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = MaterialTheme.colorScheme.primary,
                            contentColor = MaterialTheme.colorScheme.onPrimary
                        ),
                        contentPadding = PaddingValues(horizontal = 18.dp, vertical = 8.dp),
                        modifier = Modifier
                            .padding(end = 8.dp)
                            .testTag("settings-done")
                    ) {
                        Icon(Icons.Filled.Check, contentDescription = null, modifier = Modifier.size(16.dp))
                        Spacer(Modifier.width(6.dp))
                        Text("Done", fontWeight = FontWeight.SemiBold)
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = MaterialTheme.colorScheme.background
                ),
                windowInsets = TopAppBarDefaults.windowInsets.union(
                    WindowInsets.displayCutout.only(WindowInsetsSides.Horizontal)
                )
            )
        },
        containerColor = MaterialTheme.colorScheme.background
    ) { padding ->
        val configuration = LocalConfiguration.current
        val columns = SettingsLayout.columns(
            configuration.screenWidthDp,
            configuration.screenHeightDp
        )
        val account: @Composable () -> Unit = {
            TeamStationLoginCard(
                state = scoreboard,
                onSendCode = { environment.scoreboard.sendCode(it) },
                onVerify = { email, code -> environment.scoreboard.verify(email, code) },
                onSignOut = { environment.scoreboard.signOut() }
            )
        }
        val video: @Composable () -> Unit = {
            VideoCard(
                draft = draft,
                options = options,
                selected = selected,
                onDraftChange = { draft = it }
            )
        }
        val audio: @Composable () -> Unit = {
            AudioCard(
                audioEnabled = draft.audioEnabled,
                onAudioChange = { draft = draft.copy(audioEnabled = it) }
            )
        }
        val name: @Composable () -> Unit = {
            NameCard(
                draftName = draftName,
                onNameChange = { draftName = it },
                identifier = identity.cname
            )
        }
        val lenses: @Composable () -> Unit = {
            LensesCard(
                catalog = lensCatalog,
                selection = LensSelection(draft.disabledLensIDs),
                onToggle = { lens, enabled ->
                    val next = LensSelection(draft.disabledLensIDs)
                        .toggling(lens, enabled, lensCatalog)
                    draft = draft.copy(disabledLensIDs = next.disabledIDs)
                }
            )
        }
        val stream: @Composable () -> Unit = {
            StreamCard(environment, serverStatus, didCopyURL) {
                val clipboard =
                    context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                clipboard?.setPrimaryClip(ClipData.newPlainText("rtsp", environment.streamURL))
                didCopyURL = true
            }
        }
        val radarCard: @Composable () -> Unit = {
            RadarSettingsCard(
                state = radar,
                onPair = { environment.openRadarPicker() },
                onUnpair = { environment.unpairRadar() },
                onChoose = { environment.pairRadar(it) },
                onDismiss = { environment.dismissRadarPicker() },
                onStep = { environment.setRadarStep(it) },
                onEnabled = { environment.setRadarEnabled(it) }
            )
        }
        val scoreboardCard: @Composable () -> Unit = {
            ScoreboardSettingsCard(
                state = scoreboard,
                onRoute = { environment.scoreboard.selectRoute(it) },
                onV1 = { server, event -> environment.scoreboard.setV1(server, event) },
                onOpenEvents = { environment.scoreboard.openEvents() },
                onDismissEvents = { environment.scoreboard.dismissEvents() },
                onChoose = { environment.scoreboard.choose(it) },
                onAllowOverride = { environment.scoreboard.setAllowOverride(it) }
            )
        }
        // Landscape: left is video, audio, name; right is lenses, stream, radar.
        // Portrait alternates those, with the account first and the scoreboard last.
        SettingsBody(
            modifier = Modifier.padding(padding),
            columns = columns,
            header = { if (columns == 2) account() },
            left = {
                video()
                audio()
                name()
            },
            right = {
                lenses()
                stream()
                radarCard()
                if (environment.launch.isUITest) {
                    ThermalTestCard { environment.previewThermal(it) }
                }
            },
            stack = {
                account()
                video()
                lenses()
                audio()
                stream()
                name()
                radarCard()
                scoreboardCard()
                if (environment.launch.isUITest) {
                    ThermalTestCard { environment.previewThermal(it) }
                }
            },
            footer = { if (columns == 2) scoreboardCard() }
        )
    }
    }
}

@Composable
private fun SettingsCard(
    title: String,
    subtitle: String? = null,
    trailing: @Composable (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit
) {
    Card(
        shape = RoundedCornerShape(24.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceContainer
        ),
        modifier = Modifier
            .fillMaxWidth()
            .border(
                1.dp,
                MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.2f),
                RoundedCornerShape(24.dp)
            )
    ) {
        Column(modifier = Modifier.padding(20.dp)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = title.uppercase(Locale.US),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary,
                        fontWeight = FontWeight.SemiBold
                    )
                    if (subtitle != null) {
                        Text(
                            subtitle,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurface
                        )
                    }
                }
                trailing?.invoke()
            }
            Spacer(Modifier.height(12.dp))
            content()
        }
    }
}

@Composable
private fun StreamCard(
    environment: AppEnvironment,
    serverStatus: app.teamstation.cameraman.rtsp.RTSPServer.Status,
    didCopyURL: Boolean,
    onCopy: () -> Unit
) {
    SettingsCard(title = "Stream", subtitle = "Network broadcast endpoint") {
        Text(
            "Address",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(Modifier.height(6.dp))
        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(16.dp))
                .background(MaterialTheme.colorScheme.surfaceContainerLowest)
                .border(
                    1.dp,
                    MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f),
                    RoundedCornerShape(16.dp)
                )
                .clickable(onClick = onCopy)
                .padding(horizontal = 12.dp, vertical = 10.dp)
                .testTag("settings-url")
        ) {
            Text(
                environment.streamURL,
                style = MonospaceLabel,
                color = MaterialTheme.colorScheme.primary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f)
            )
            Icon(
                imageVector = if (didCopyURL) Icons.Filled.Check else Icons.Filled.ContentCopy,
                contentDescription = "Copy stream address",
                tint = if (didCopyURL) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.onSurface
                },
                modifier = Modifier
                    .size(18.dp)
                    .testTag("settings-url-copy")
            )
        }
        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
            StatusChip(Modifier.weight(1f)) {
                Text("Clients", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(
                    serverStatus.clientCount.toString(),
                    style = MonospaceLabel,
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.testTag("settings-clients")
                )
            }
            StatusChip(Modifier.weight(1f)) {
                Text("Discovery", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (serverStatus.isAdvertising) {
                        Box(
                            Modifier
                                .size(6.dp)
                                .background(MaterialTheme.colorScheme.primary, CircleShape)
                        )
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(
                        if (serverStatus.isAdvertising) "advertising" else "not advertising",
                        style = MonospaceLabel,
                        color = if (serverStatus.isAdvertising) {
                            MaterialTheme.colorScheme.primary
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                        modifier = Modifier.testTag("settings-advertising")
                    )
                }
            }
        }
    }
}

@Composable
private fun StatusChip(modifier: Modifier = Modifier, content: @Composable RowScope.() -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
        modifier = modifier
            .background(MaterialTheme.colorScheme.surfaceContainerLow, RoundedCornerShape(16.dp))
            .padding(horizontal = 12.dp, vertical = 10.dp),
        content = content
    )
}

@Composable
private fun NameCard(draftName: String, onNameChange: (String) -> Unit, identifier: String) {
    SettingsCard(title = "Name & identity") {
        OutlinedTextField(
            value = draftName,
            onValueChange = onNameChange,
            singleLine = true,
            label = { Text("Camera name") },
            // Worth saying here rather than in a line of its own, because the obvious assumption is
            // the opposite — that renaming a camera is what makes it a different camera — and this
            // is the field where that assumption gets acted on.
            supportingText = { Text("Renaming keeps this camera's identity.") },
            textStyle = MaterialTheme.typography.bodyLarge.copy(fontWeight = FontWeight.SemiBold),
            shape = RoundedCornerShape(16.dp),
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = MaterialTheme.colorScheme.primary,
                unfocusedBorderColor = MaterialTheme.colorScheme.outline,
                focusedLabelColor = MaterialTheme.colorScheme.primary,
                unfocusedLabelColor = MaterialTheme.colorScheme.primary
            ),
            modifier = Modifier
                .fillMaxWidth()
                .testTag("settings-name-field")
        )
        StackedValue("Identifier", identifier, "settings-cname")
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun VideoCard(
    draft: app.teamstation.streamcore.core.StreamSettings,
    options: List<FormatCatalogue.Option>,
    selected: FormatCatalogue.Option?,
    onDraftChange: (app.teamstation.streamcore.core.StreamSettings) -> Unit
) {
    SettingsCard(
        title = "Video",
        subtitle = "Encoding & bitrate settings",
        trailing = {
            Text(
                if (draft.cameraPosition.name.equals("FRONT", ignoreCase = true)) "Front" else "Back",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.outline,
                modifier = Modifier
                    .background(MaterialTheme.colorScheme.surfaceContainerHigh, CircleShape)
                    .padding(horizontal = 10.dp, vertical = 4.dp)
            )
        }
    ) {
        Text(
            "Codec format",
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(Modifier.height(8.dp))
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.surfaceContainerLowest)
                .border(
                    1.dp,
                    MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.4f),
                    CircleShape
                )
                .padding(4.dp)
        ) {
            StreamCodec.entries.forEach { codec ->
                val selected = draft.codec == codec
                Row(
                    horizontalArrangement = Arrangement.Center,
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .weight(1f)
                        .clip(CircleShape)
                        .background(
                            if (selected) MaterialTheme.colorScheme.primary else Color.Transparent
                        )
                        .clickable { onDraftChange(draft.copy().apply { selectCodec(codec) }) }
                        .padding(vertical = 10.dp)
                        .testTag("settings-codec-${codec.rawValue}")
                ) {
                    if (selected) {
                        Icon(
                            Icons.Filled.Check,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onPrimary,
                            modifier = Modifier.size(16.dp)
                        )
                        Spacer(Modifier.width(6.dp))
                    }
                    Text(
                        codec.displayName,
                        color = if (selected) {
                            MaterialTheme.colorScheme.onPrimary
                        } else {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        },
                        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium
                    )
                }
            }
        }

        // A menu rather than the list inline, so the card keeps one height however many of the
        // offered formats this handset serves, and the row reads like the codec row above it.
        var isPickingFormat by remember { mutableStateOf(false) }
        ExposedDropdownMenuBox(
            expanded = isPickingFormat,
            onExpandedChange = { isPickingFormat = it },
            modifier = Modifier.padding(top = 16.dp)
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
                shape = RoundedCornerShape(16.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = MaterialTheme.colorScheme.primary,
                    unfocusedBorderColor = MaterialTheme.colorScheme.outline,
                    focusedLabelColor = MaterialTheme.colorScheme.primary,
                    unfocusedLabelColor = MaterialTheme.colorScheme.primary
                ),
                modifier = Modifier
                    .menuAnchor(MenuAnchorType.PrimaryNotEditable)
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

        Column(
            modifier = Modifier
                .padding(top = 16.dp)
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.surfaceContainerLow, RoundedCornerShape(16.dp))
                .padding(16.dp)
        ) {
            val mbps = draft.bitrate / 1_000_000.0
            val floorMbps = draft.bitrateFloor / 1_000_000.0
            // Two spaces, which the Maestro flows match on: "Bitrate  2.0–8.0 Mbps" while adapting,
            // the floor to the rate, and "Bitrate  6.0 Mbps" otherwise.
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth()
            ) {
                Text("Bitrate range", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                Text(
                    if (draft.adaptiveBitrate) {
                        String.format(Locale.US, "Bitrate  %.1f–%.1f Mbps", floorMbps, mbps)
                    } else {
                        String.format(Locale.US, "Bitrate  %.1f Mbps", mbps)
                    },
                    style = MonospaceLabel,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier
                        .background(
                            MaterialTheme.colorScheme.primary.copy(alpha = 0.2f),
                            RoundedCornerShape(8.dp)
                        )
                        .padding(horizontal = 8.dp, vertical = 4.dp)
                        .testTag("settings-bitrate-value")
                )
            }
            // Swapped in place by the switch below. Adapting, the operator sets the range the stream
            // may move in; not adapting, the one rate it runs at, and a floor on screen would be a
            // setting that does nothing.
            //
            // Both are continuous rather than stepped: Material 3 draws a tick for every step, and 97
            // of them turned the track into a dotted line that read as a progress bar. The
            // half-megabit granularity the iOS build steps in is kept by rounding the value instead.
            if (draft.adaptiveBitrate) {
                // Green between the thumbs, as on iOS: the range the stream may run in.
                val colors = SliderDefaults.colors(
                    thumbColor = MaterialTheme.colorScheme.primary,
                    activeTrackColor = MaterialTheme.colorScheme.tertiary,
                    inactiveTrackColor = MaterialTheme.colorScheme.outlineVariant
                )
                val lowInteraction = remember { MutableInteractionSource() }
                val highInteraction = remember { MutableInteractionSource() }
                RangeSlider(
                    value = floorMbps.toFloat()..mbps.toFloat(),
                    onValueChange = { range ->
                        val high = halfMegabitBits(range.endInclusive)
                        val low = minOf(halfMegabitBits(range.start), high)
                        // Set as they are, not through `selectBitrate`: the operator is moving one
                        // thumb, and the other must stay where they left it.
                        onDraftChange(draft.copy(bitrate = high, bitrateFloor = low))
                    },
                    valueRange = 1f..(app.teamstation.streamcore.core.StreamSettings.maximumBitrate / 1_000_000f),
                    colors = colors,
                    startInteractionSource = lowInteraction,
                    endInteractionSource = highInteraction,
                    startThumb = {
                        SliderDefaults.Thumb(
                            interactionSource = lowInteraction,
                            colors = colors,
                            modifier = Modifier.testTag("settings-bitrate-low")
                        )
                    },
                    endThumb = {
                        SliderDefaults.Thumb(
                            interactionSource = highInteraction,
                            colors = colors,
                            modifier = Modifier.testTag("settings-bitrate-high")
                        )
                    },
                    // No gap beside the thumbs and no dot at the end. An everyday 2–8 Mbps is a
                    // short stretch of this track, and Material's gaps swallowed the green between
                    // the thumbs whole, while the end dot read as where the range stopped.
                    track = { state ->
                        SliderDefaults.Track(
                            rangeSliderState = state,
                            colors = colors,
                            drawStopIndicator = null,
                            thumbTrackGapSize = 0.dp
                        )
                    }
                )
            } else {
                Slider(
                    value = mbps.toFloat(),
                    onValueChange = { value ->
                        // `selectBitrate`, so a floor the operator never chose keeps following the
                        // rate at half and turning adaptation on starts from there.
                        onDraftChange(draft.copy().apply { selectBitrate(halfMegabitBits(value)) })
                    },
                    valueRange = 1f..(app.teamstation.streamcore.core.StreamSettings.maximumBitrate / 1_000_000f),
                    // The default inactive track is `surfaceContainerHighest`, which against this
                    // card's `surfaceContainer` is very nearly the same colour — the track vanished
                    // and the control read as a stray dot. Naming the roles explicitly is the theming
                    // answer.
                    colors = SliderDefaults.colors(
                        thumbColor = MaterialTheme.colorScheme.primary,
                        activeTrackColor = MaterialTheme.colorScheme.primary,
                        inactiveTrackColor = MaterialTheme.colorScheme.outlineVariant
                    ),
                    modifier = Modifier.testTag("settings-bitrate")
                )
            }
        }

        Row(
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 12.dp)
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text("Adaptive bitrate", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                Text(
                    "Comes down toward the low rate only while the network cannot keep up",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Switch(
                checked = draft.adaptiveBitrate,
                onCheckedChange = { onDraftChange(draft.copy(adaptiveBitrate = it)) },
                modifier = Modifier.testTag("settings-adaptive-bitrate")
            )
        }
    }
}

/** A slider's megabits, rounded to the half megabit the iOS build steps in, as bits per second. */
private fun halfMegabitBits(mbps: Float): Int = (Math.round(mbps * 2f) / 2.0 * 1_000_000).toInt()

/**
 * One row per detected lens. Millimetre labels come from the optics, so each handset lists the
 * cameras it actually has rather than a table someone typed in.
 */
@Composable
internal fun LensesCard(
    catalog: List<CameraLens>,
    selection: LensSelection,
    onToggle: (CameraLens, Boolean) -> Unit
) {
    if (catalog.isEmpty()) return
    SettingsCard(
        title = "Lenses",
        subtitle = "Available sensor focal lengths",
        trailing = {
            Text(
                "${catalog.size} sensors",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    ) {
        for (lens in catalog) {
            val enabled = selection.isEnabled(lens)
            // The last lens at a position cannot be turned off: capture would have nothing to open.
            // The row stays visible and stops responding rather than disappearing, so it is obvious
            // why it will not move.
            val canChange = enabled && selection.canDisable(lens, catalog) || !enabled
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = 4.dp)
            ) {
                Box(
                    contentAlignment = Alignment.Center,
                    modifier = Modifier
                        .size(28.dp)
                        .background(MaterialTheme.colorScheme.surfaceContainerHigh, CircleShape)
                ) {
                    Text(
                        app.teamstation.streamcore.core.ZoomMapping.label(lens.displayedZoom),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1
                    )
                }
                Spacer(Modifier.width(10.dp))
                Text(
                    lens.settingsLabel,
                    style = MaterialTheme.typography.bodyMedium,
                    color = if (canChange) {
                        MaterialTheme.colorScheme.onSurface
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                    modifier = Modifier.weight(1f)
                )
                Switch(
                    checked = enabled,
                    onCheckedChange = { onToggle(lens, it) },
                    enabled = canChange,
                    modifier = Modifier.testTag(lens.testTag)
                )
            }
        }
    }
}

/**
 * Forces the thermal pill to each level for a few seconds.
 *
 * Only under `uiTest`. A pill that only appears when a phone is genuinely hot cannot be checked
 * before a match, and "wait for it to overheat" is not a test step.
 */
@Composable
private fun ThermalTestCard(onPreview: (ThermalBadgeLevel) -> Unit) {
    // A bare row rather than a card: this is test chrome, and the height a card's title would cost
    // is height the lens list needs.
    Row(
        horizontalArrangement = Arrangement.spacedBy(2.dp),
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .testTag("settings-test-thermal")
    ) {
        for (level in ThermalBadgeLevel.entries) {
            TextButton(
                onClick = { onPreview(level) },
                contentPadding = PaddingValues(horizontal = 6.dp, vertical = 2.dp),
                modifier = Modifier.testTag("settings-test-thermal-${level.rawValue}")
            ) {
                Text(level.label, style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

@Composable
private fun AudioCard(audioEnabled: Boolean, onAudioChange: (Boolean) -> Unit) {
    SettingsCard(
        title = "Audio",
        subtitle = "Microphone input",
        trailing = {
            Switch(
                checked = audioEnabled,
                onCheckedChange = onAudioChange,
                modifier = Modifier.testTag("settings-audio")
            )
        }
    ) {}
}

/**
 * A label above its value.
 *
 * For anything too long to sit beside its label in a narrow column — the RTSP address, the camera's
 * identifier. Both are read character by character against a second device, so ellipsising them is
 * not an option and squeezing the label until it wraps one letter per line is worse.
 */
@Composable
private fun StackedValue(label: String, value: String, testTag: String) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Text(
            value,
            style = MonospaceLabel,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier
                .fillMaxWidth()
                .background(MaterialTheme.colorScheme.surfaceContainerLowest, RoundedCornerShape(12.dp))
                .border(
                    1.dp,
                    MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.3f),
                    RoundedCornerShape(12.dp)
                )
                .padding(horizontal = 12.dp, vertical = 8.dp)
                .testTag(testTag)
        )
    }
}
