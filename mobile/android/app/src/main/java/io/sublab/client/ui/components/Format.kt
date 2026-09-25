package io.sublab.client.ui.components

import androidx.compose.ui.graphics.Color
import io.sublab.client.ui.theme.Palette
import java.util.Locale

fun formatBytes(bytes: Long): String {
    if (bytes < 1024) return "$bytes Б"
    val units = listOf("КБ", "МБ", "ГБ", "ТБ")
    var value = bytes / 1024.0
    var index = 0
    while (value >= 1024 && index < units.lastIndex) {
        value /= 1024
        index++
    }
    val pattern = if (value >= 100) "%.0f %s" else "%.1f %s"
    return String.format(Locale.US, pattern, value, units[index])
}

fun formatSpeed(bytesPerSecond: Long): String = "${formatBytes(bytesPerSecond)}/с"

fun formatDuration(millis: Long): String {
    val total = (millis / 1000).coerceAtLeast(0)
    val hours = total / 3600
    val minutes = total % 3600 / 60
    val seconds = total % 60
    return String.format(Locale.US, "%02d:%02d:%02d", hours, minutes, seconds)
}

fun pingColor(ms: Int?): Color = when {
    ms == null -> Palette.TextMuted
    ms < 0 -> Palette.Red
    ms < 150 -> Palette.Green
    ms < 400 -> Palette.Amber
    else -> Palette.Red
}

fun pingLabel(ms: Int?): String = when {
    ms == null -> "—"
    ms < 0 -> "нет ответа"
    else -> "$ms мс"
}

/** «осталось 12 дн.» / «истекла» / null для бессрочной. */
fun expireLabel(expireSeconds: Long, now: Long = System.currentTimeMillis()): String? {
    if (expireSeconds <= 0) return null
    val days = (expireSeconds * 1000 - now) / 86_400_000
    return when {
        expireSeconds * 1000 < now -> "истекла"
        days < 1 -> "меньше дня"
        else -> "осталось $days ${plural(days, "день", "дня", "дней")}"
    }
}

fun plural(count: Long, one: String, few: String, many: String): String {
    val mod100 = count % 100
    val mod10 = count % 10
    return when {
        mod100 in 11L..14L -> many
        mod10 == 1L -> one
        mod10 in 2L..4L -> few
        else -> many
    }
}

fun protocolLabel(type: String): String = when (type) {
    "ss" -> "Shadowsocks"
    "vless" -> "VLESS"
    "vmess" -> "VMess"
    "trojan" -> "Trojan"
    "hysteria2" -> "Hysteria2"
    "hysteria" -> "Hysteria"
    "tuic" -> "TUIC"
    "wireguard" -> "WireGuard"
    else -> type.uppercase(Locale.ROOT)
}
