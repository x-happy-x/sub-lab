package io.sublab.client.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.rounded.Notes
import androidx.compose.material.icons.rounded.Code
import androidx.compose.material.icons.rounded.Dns
import androidx.compose.material.icons.rounded.Flag
import androidx.compose.material.icons.rounded.Lan
import androidx.compose.material.icons.rounded.Language
import androidx.compose.material.icons.rounded.Memory
import androidx.compose.material.icons.rounded.Person
import androidx.compose.material.icons.rounded.Tune
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.sublab.client.core.Engine
import io.sublab.client.data.AppSettings
import io.sublab.client.ui.components.EngineSwitch
import io.sublab.client.ui.components.Panel
import io.sublab.client.ui.components.SectionTitle
import io.sublab.client.ui.theme.Palette

@Composable
fun SettingsScreen(
    settings: AppSettings,
    versions: String,
    onEngine: (Engine) -> Unit,
    onUpdate: (restart: Boolean, transform: (AppSettings) -> AppSettings) -> Unit,
    loadLogs: suspend () -> String,
    loadConfig: suspend () -> String,
) {
    var editing by remember { mutableStateOf<EditField?>(null) }
    var textDialog by remember { mutableStateOf<TextDialog?>(null) }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp),
    ) {
        Text(
            "Настройки",
            fontSize = 26.sp,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(start = 4.dp, top = 20.dp, bottom = 8.dp),
        )

        SectionTitle("Ядро")
        Panel(Modifier.fillMaxWidth()) {
            EngineSwitch(selected = settings.engine, onSelect = onEngine, modifier = Modifier.fillMaxWidth())
            Spacer(Modifier.height(12.dp))
            Text(
                when (settings.engine) {
                    Engine.XRAY -> "Xray-core: VLESS (Reality, XHTTP, Vision), VMess, Trojan, Shadowsocks, Hysteria2."
                    Engine.MIHOMO -> "Mihomo (Clash Meta): всё то же плюс TUIC, Hysteria, WireGuard, AnyTLS и Shadowsocks-плагины."
                },
                color = Palette.TextSecondary,
                fontSize = 13.sp,
            )
            if (versions.isNotEmpty()) {
                Spacer(Modifier.height(8.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Rounded.Memory, null, tint = Palette.TextMuted, modifier = Modifier.size(14.dp))
                    Spacer(Modifier.width(6.dp))
                    Text(versions, color = Palette.TextMuted, fontSize = 12.sp)
                }
            }
        }

        SectionTitle("Маршрутизация")
        Panel(Modifier.fillMaxWidth()) {
            ToggleRow(Icons.Rounded.Lan, "Локальная сеть напрямую", "Роутер, принтер, NAS — мимо VPN", settings.bypassLan) { value ->
                onUpdate(true) { it.copy(bypassLan = value) }
            }
            Divider()
            ToggleRow(Icons.Rounded.Flag, "Российские сайты напрямую", "Домены .ru, .рф и .su — мимо VPN", settings.directRu) { value ->
                onUpdate(true) { it.copy(directRu = value) }
            }
            Divider()
            ToggleRow(Icons.Rounded.Language, "IPv6", "Пускать IPv6-трафик через туннель", settings.ipv6) { value ->
                onUpdate(true) { it.copy(ipv6 = value) }
            }
        }

        SectionTitle("Сеть")
        Panel(Modifier.fillMaxWidth()) {
            ValueRow(Icons.Rounded.Dns, "DNS", settings.dns) { editing = EditField.DNS }
            Divider()
            ValueRow(Icons.Rounded.Person, "User-Agent подписки", settings.userAgent) { editing = EditField.USER_AGENT }
            Divider()
            ValueRow(Icons.Rounded.Tune, "Уровень журнала", settings.logLevel) { editing = EditField.LOG_LEVEL }
        }

        SectionTitle("Диагностика")
        Panel(Modifier.fillMaxWidth()) {
            ValueRow(Icons.AutoMirrored.Rounded.Notes, "Журнал ядра", "") { textDialog = TextDialog("Журнал", loadLogs) }
            Divider()
            ValueRow(Icons.Rounded.Code, "Конфиг текущего сервера", "") { textDialog = TextDialog("Конфиг ${settings.engine.title}", loadConfig) }
        }

        Spacer(Modifier.height(24.dp))
        Text(
            "sub·lab client · Xray и Mihomo в одном приложении",
            color = Palette.TextMuted,
            fontSize = 12.sp,
            modifier = Modifier.align(Alignment.CenterHorizontally),
        )
        Spacer(Modifier.height(24.dp))
    }

    editing?.let { field ->
        EditDialog(field, settings, onDismiss = { editing = null }) { value ->
            editing = null
            when (field) {
                EditField.DNS -> onUpdate(true) { it.copy(dns = value) }
                EditField.USER_AGENT -> onUpdate(false) { it.copy(userAgent = value) }
                EditField.LOG_LEVEL -> onUpdate(true) { it.copy(logLevel = value) }
            }
        }
    }

    textDialog?.let { dialog ->
        TextViewer(dialog) { textDialog = null }
    }
}

private enum class EditField(val title: String, val hint: String) {
    DNS("DNS-сервер", "1.1.1.1, 8.8.8.8 или https://1.1.1.1/dns-query"),
    USER_AGENT("User-Agent", "С каким клиентом представляться серверу подписки"),
    LOG_LEVEL("Уровень журнала", "debug, info, warning или error"),
}

private class TextDialog(val title: String, val load: suspend () -> String)

@Composable
private fun Divider() = HorizontalDivider(color = Palette.Stroke, modifier = Modifier.padding(vertical = 4.dp))

@Composable
private fun RowIcon(icon: ImageVector) {
    Box(
        Modifier
            .size(34.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(Palette.SurfaceHighest),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, null, tint = Palette.VioletSoft, modifier = Modifier.size(18.dp))
    }
}

@Composable
private fun ToggleRow(icon: ImageVector, title: String, subtitle: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable { onChange(!checked) }
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RowIcon(icon)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 15.sp, fontWeight = FontWeight.Medium)
            Text(subtitle, color = Palette.TextSecondary, fontSize = 12.sp)
        }
        Switch(
            checked = checked,
            onCheckedChange = onChange,
            colors = SwitchDefaults.colors(
                checkedThumbColor = Palette.TextPrimary,
                checkedTrackColor = Palette.Violet,
                uncheckedThumbColor = Palette.TextSecondary,
                uncheckedTrackColor = Palette.SurfaceHighest,
                uncheckedBorderColor = Palette.Stroke,
            ),
        )
    }
}

@Composable
private fun ValueRow(icon: ImageVector, title: String, value: String, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RowIcon(icon)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 15.sp, fontWeight = FontWeight.Medium)
            if (value.isNotEmpty()) Text(value, color = Palette.TextSecondary, fontSize = 12.sp, maxLines = 1)
        }
        Icon(Icons.AutoMirrored.Rounded.KeyboardArrowRight, null, tint = Palette.TextMuted)
    }
}

@Composable
private fun EditDialog(field: EditField, settings: AppSettings, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    val initial = when (field) {
        EditField.DNS -> settings.dns
        EditField.USER_AGENT -> settings.userAgent
        EditField.LOG_LEVEL -> settings.logLevel
    }
    var value by remember { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Palette.SurfaceHigh,
        title = { Text(field.title) },
        text = {
            Column {
                Text(field.hint, color = Palette.TextSecondary, fontSize = 13.sp)
                Spacer(Modifier.height(12.dp))
                if (field == EditField.LOG_LEVEL) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        listOf("debug", "info", "warning", "error").forEach { level ->
                            TextButton(onClick = { value = level }) {
                                Text(level, color = if (value == level) Palette.VioletSoft else Palette.TextSecondary)
                            }
                        }
                    }
                } else {
                    OutlinedTextField(value = value, onValueChange = { value = it }, singleLine = true)
                }
                if (field == EditField.USER_AGENT) {
                    TextButton(onClick = { value = AppSettings.DEFAULT_USER_AGENT }) { Text("По умолчанию") }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { if (value.isNotBlank()) onSave(value.trim()) }) { Text("Сохранить") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Отмена") } },
    )
}

@Composable
private fun TextViewer(dialog: TextDialog, onDismiss: () -> Unit) {
    var text by remember(dialog) { mutableStateOf("Загрузка…") }
    LaunchedEffect(dialog) { text = dialog.load() }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Palette.SurfaceHigh,
        title = { Text(dialog.title) },
        text = {
            Box(
                Modifier
                    .fillMaxWidth()
                    .heightIn(max = 420.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(Palette.Background)
                    .verticalScroll(rememberScrollState())
                    .horizontalScroll(rememberScrollState())
                    .padding(12.dp),
            ) {
                SelectionContainer {
                    Text(text, fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = Palette.TextSecondary)
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("Закрыть") } },
    )
}
