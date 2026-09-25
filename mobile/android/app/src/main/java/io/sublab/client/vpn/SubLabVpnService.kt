package io.sublab.client.vpn

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.VpnService
import android.os.Build
import android.os.ParcelFileDescriptor
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import io.sublab.client.MainActivity
import io.sublab.client.R
import io.sublab.client.SubLabApp
import io.sublab.client.core.CoreBridge
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * VPN-сервис: открывает TUN и отдаёт его дескриптор выбранному ядру.
 *
 * Трафик самого приложения исключён из туннеля (addDisallowedApplication), поэтому
 * соединения ядер с серверами идут напрямую и не зацикливаются.
 */
class SubLabVpnService : VpnService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lock = Mutex()
    private var tun: ParcelFileDescriptor? = null

    /** Параметры, с которыми открыт текущий TUN: при их смене его надо пересоздать. */
    private var tunKey: String? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                scope.launch { lock.withLock { shutdown() } }
                return START_NOT_STICKY
            }
            ACTION_RESTART -> {
                promoteToForeground(getString(R.string.app_name))
                scope.launch { lock.withLock { connect(reuseTun = true) } }
            }
            else -> {
                // Запуск из системы («постоянная VPN») приходит без action.
                promoteToForeground(getString(R.string.app_name))
                scope.launch { lock.withLock { connect(reuseTun = false) } }
            }
        }
        return START_STICKY
    }

    private fun connect(reuseTun: Boolean) {
        val repository = SubLabApp.instance.repository
        val settings = repository.settings.value
        val node = repository.selectedNode()
        if (node == null) {
            fail("Добавьте подписку и выберите сервер")
            return
        }
        if (!node.supports(settings.engine)) {
            fail("«${node.title}» (${node.type}) не работает на ядре ${settings.engine.title}")
            return
        }

        VpnController.update(VpnState.Connecting)
        try {
            val key = "${settings.ipv6}|${settings.dns}"
            val current = tun
            val descriptor = if (reuseTun && current != null && tunKey == key) {
                current
            } else {
                // Старое ядро держит копию fd, поэтому сначала останавливаем его.
                releaseTun()
                openTun(settings.ipv6, settings.dns).also {
                    tun = it
                    tunKey = key
                }
            }
            CoreBridge.start(settings.engine, node.json, descriptor.fd, settings.coreOptions(MTU))
            VpnController.update(VpnState.Connected(System.currentTimeMillis(), settings.engine, node.title))
            promoteToForeground("${node.title} · ${settings.engine.title}")
        } catch (error: Exception) {
            Log.e(TAG, "connect failed", error)
            fail(error.message ?: error.toString())
        }
    }

    private fun openTun(ipv6: Boolean, dns: String): ParcelFileDescriptor {
        val builder = Builder()
            .setSession(getString(R.string.app_name))
            .setMtu(MTU)
            .addAddress(TUN_ADDRESS, 30)
            .addRoute("0.0.0.0", 0)
            .addDnsServer(tunDns(dns))
            .addDisallowedApplication(packageName)
            .setConfigureIntent(openAppIntent())
        if (ipv6) {
            builder.addAddress(TUN_ADDRESS6, 126).addRoute("::", 0)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            builder.setMetered(false)
        }
        return builder.establish() ?: throw IllegalStateException("Нет разрешения на VPN")
    }

    /** Системе нужен IP; если в настройках DoH/доменное имя — берём публичный DNS. */
    private fun tunDns(dns: String): String {
        val host = dns.substringAfter("://").substringBefore('/').substringBefore(':')
        return if (host.matches(Regex("\\d{1,3}(\\.\\d{1,3}){3}"))) host else "1.1.1.1"
    }

    private fun fail(message: String) {
        VpnController.update(VpnState.Failed(message))
        releaseTun()
        stopForegroundCompat()
        stopSelf()
    }

    private fun shutdown() {
        VpnController.update(VpnState.Stopping)
        releaseTun()
        VpnController.update(VpnState.Idle)
        stopForegroundCompat()
        stopSelf()
    }

    private fun releaseTun() {
        runCatching { CoreBridge.stop() }.onFailure { Log.w(TAG, "core stop", it) }
        runCatching { tun?.close() }
        tun = null
        tunKey = null
    }

    override fun onRevoke() {
        // Другое VPN-приложение забрало туннель или пользователь отключил нас в настройках.
        scope.launch { lock.withLock { shutdown() } }
    }

    override fun onDestroy() {
        if (tun != null) {
            releaseTun()
            VpnController.update(VpnState.Idle)
        }
        scope.cancel()
        super.onDestroy()
    }

    private fun promoteToForeground(text: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, getString(R.string.notification_channel), NotificationManager.IMPORTANCE_LOW)
                .apply { setShowBadge(false) },
        )
        val stopIntent = PendingIntent.getService(
            this,
            1,
            Intent(this, SubLabVpnService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_vpn)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setContentIntent(openAppIntent())
            .setOngoing(true)
            .setSilent(true)
            .addAction(0, "Отключить", stopIntent)
            .build()
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        } else {
            0
        }
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
    }

    private fun stopForegroundCompat() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
    }

    private fun openAppIntent(): PendingIntent = PendingIntent.getActivity(
        this,
        0,
        Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE,
    )

    companion object {
        const val ACTION_START = "io.sublab.client.START"
        const val ACTION_RESTART = "io.sublab.client.RESTART"
        const val ACTION_STOP = "io.sublab.client.STOP"

        private const val TAG = "SubLabVpn"
        private const val CHANNEL_ID = "vpn"
        private const val NOTIFICATION_ID = 1
        private const val MTU = 1500
        private const val TUN_ADDRESS = "172.19.0.1"
        private const val TUN_ADDRESS6 = "fdfe:dcba:9876::1"
    }
}
