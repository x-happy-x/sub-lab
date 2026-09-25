package io.sublab.client.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Bolt
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Edit
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.NetworkCheck
import androidx.compose.material.icons.rounded.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.sublab.client.core.Engine
import io.sublab.client.data.ServerNode
import io.sublab.client.data.Subscription
import io.sublab.client.ui.Pings
import io.sublab.client.ui.components.Chip
import io.sublab.client.ui.components.FlagBadge
import io.sublab.client.ui.components.PingText
import io.sublab.client.ui.components.expireLabel
import io.sublab.client.ui.components.formatBytes
import io.sublab.client.ui.components.plural
import io.sublab.client.ui.components.protocolLabel
import io.sublab.client.ui.theme.Palette
import java.text.DateFormat
import java.util.Date

@Composable
fun ServersScreen(
    subscriptions: List<Subscription>,
    selectedId: String?,
    engine: Engine,
    pings: Pings,
    pinging: Boolean,
    refreshing: Boolean,
    onSelect: (ServerNode) -> Unit,
    onPingAll: () -> Unit,
    onFastest: () -> Unit,
    onRefreshAll: () -> Unit,
    onRefresh: (Subscription) -> Unit,
    onRename: (Subscription, String) -> Unit,
    onDelete: (Subscription) -> Unit,
    onAdd: () -> Unit,
) {
    Column(Modifier.fillMaxSize()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 20.dp, end = 8.dp, top = 12.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Серверы", fontSize = 26.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
            ToolbarButton(Icons.Rounded.Bolt, "Самый быстрый", onFastest)
            if (pinging) {
                Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = Palette.Cyan)
                }
            } else {
                ToolbarButton(Icons.Rounded.NetworkCheck, "Проверить пинг", onPingAll)
            }
            if (refreshing) {
                Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp, color = Palette.Violet)
                }
            } else {
                ToolbarButton(Icons.Rounded.Refresh, "Обновить подписки", onRefreshAll)
            }
            ToolbarButton(Icons.Rounded.Add, "Добавить подписку", onAdd)
        }

        if (subscriptions.isEmpty()) {
            EmptyServers(onAdd)
            return@Column
        }

        LazyColumn(
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            subscriptions.forEach { subscription ->
                item(key = "header-${subscription.id}") {
                    SubscriptionHeader(subscription, onRefresh, onRename, onDelete)
                }
                items(subscription.nodes, key = { it.id }) { node ->
                    ServerRow(
                        node = node,
                        selected = node.id == selectedId,
                        engine = engine,
                        ping = pings[node.id],
                        onClick = { onSelect(node) },
                    )
                }
            }
        }
    }
}

@Composable
private fun ToolbarButton(icon: ImageVector, description: String, onClick: () -> Unit) {
    IconButton(onClick = onClick) {
        Icon(icon, contentDescription = description, tint = Palette.TextSecondary)
    }
}

@Composable
private fun SubscriptionHeader(
    subscription: Subscription,
    onRefresh: (Subscription) -> Unit,
    onRename: (Subscription, String) -> Unit,
    onDelete: (Subscription) -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 4.dp, top = 14.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                subscription.name,
                fontSize = 15.sp,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            val count = subscription.nodes.size.toLong()
            val details = buildList {
                add("$count ${plural(count, "сервер", "сервера", "серверов")}")
                if (subscription.total > 0) add("${formatBytes(subscription.used)} / ${formatBytes(subscription.total)}")
                expireLabel(subscription.expire)?.let { add(it) }
                if (subscription.updatedAt > 0) {
                    add(DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(subscription.updatedAt)))
                }
            }
            Text(details.joinToString(" · "), color = Palette.TextMuted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            subscription.error?.let {
                Text(it, color = Palette.Red, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        Box {
            IconButton(onClick = { menu = true }) {
                Icon(Icons.Rounded.MoreVert, contentDescription = "Действия", tint = Palette.TextMuted)
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                if (subscription.url.isNotEmpty()) {
                    DropdownMenuItem(
                        text = { Text("Обновить") },
                        leadingIcon = { Icon(Icons.Rounded.Refresh, null) },
                        onClick = {
                            menu = false
                            onRefresh(subscription)
                        },
                    )
                }
                DropdownMenuItem(
                    text = { Text("Переименовать") },
                    leadingIcon = { Icon(Icons.Rounded.Edit, null) },
                    onClick = {
                        menu = false
                        renaming = true
                    },
                )
                DropdownMenuItem(
                    text = { Text("Удалить", color = Palette.Red) },
                    leadingIcon = { Icon(Icons.Rounded.Delete, null, tint = Palette.Red) },
                    onClick = {
                        menu = false
                        confirmDelete = true
                    },
                )
            }
        }
    }

    if (renaming) {
        var name by remember { mutableStateOf(subscription.name) }
        AlertDialog(
            onDismissRequest = { renaming = false },
            containerColor = Palette.SurfaceHigh,
            title = { Text("Название подписки") },
            text = { OutlinedTextField(value = name, onValueChange = { name = it }, singleLine = true) },
            confirmButton = {
                TextButton(onClick = {
                    renaming = false
                    if (name.isNotBlank()) onRename(subscription, name.trim())
                }) { Text("Сохранить") }
            },
            dismissButton = { TextButton(onClick = { renaming = false }) { Text("Отмена") } },
        )
    }

    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            containerColor = Palette.SurfaceHigh,
            title = { Text("Удалить подписку?") },
            text = { Text("«${subscription.name}» и все её серверы пропадут из приложения.") },
            confirmButton = {
                TextButton(onClick = {
                    confirmDelete = false
                    onDelete(subscription)
                }) { Text("Удалить", color = Palette.Red) }
            },
            dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Отмена") } },
        )
    }
}

@Composable
private fun ServerRow(node: ServerNode, selected: Boolean, engine: Engine, ping: Int?, onClick: () -> Unit) {
    val supported = node.supports(engine)
    val shape = RoundedCornerShape(18.dp)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(if (selected) Palette.SurfaceHigh else Palette.Surface)
            .border(1.dp, if (selected) Palette.Violet else Palette.Stroke, shape)
            .clickable(onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        FlagBadge(node.flag, size = 38)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(
                node.title,
                color = if (supported) Palette.TextPrimary else Palette.TextMuted,
                fontSize = 15.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(4.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Chip(protocolLabel(node.type))
                if (!node.xray) Chip("только Mihomo", color = Palette.Amber)
                if (!node.mihomo) Chip("только Xray", color = Palette.Amber)
            }
        }
        Spacer(Modifier.width(8.dp))
        Column(horizontalAlignment = Alignment.End) {
            PingText(ping)
            Spacer(Modifier.height(6.dp))
            Box(
                Modifier
                    .size(18.dp)
                    .clip(CircleShape)
                    .border(2.dp, if (selected) Palette.Violet else Palette.Stroke, CircleShape)
                    .padding(4.dp)
                    .clip(CircleShape)
                    .background(if (selected) Palette.Violet else Palette.Surface),
            )
        }
    }
}

@Composable
private fun EmptyServers(onAdd: () -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        FlagBadge(null, size = 72)
        Spacer(Modifier.height(16.dp))
        Text("Пока пусто", fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
        Spacer(Modifier.height(6.dp))
        Text(
            "Добавьте ссылку на подписку — подойдут ссылки sub-lab, Remnawave, Marzban и любые списки vless:// / vmess:// / trojan:// / ss://",
            color = Palette.TextSecondary,
            fontSize = 14.sp,
        )
        Spacer(Modifier.height(20.dp))
        TextButton(onClick = onAdd) { Text("Добавить подписку", color = Palette.VioletSoft) }
    }
}
