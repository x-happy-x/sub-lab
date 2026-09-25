package io.sublab.client.core

import libcore.Libcore

/** Ядро, на котором поднимается туннель. */
enum class Engine(val id: String, val title: String) {
    XRAY("xray", "Xray"),
    MIHOMO("mihomo", "Mihomo");

    companion object {
        fun of(id: String?): Engine = entries.firstOrNull { it.id == id } ?: XRAY
    }
}

/**
 * Тонкая обёртка над gomobile-библиотекой libcore: все вызовы Go идут через неё,
 * чтобы остальной код не зависел от сгенерированных классов.
 */
object CoreBridge {
    fun init(dir: String) = Libcore.init(dir)

    fun parseSubscription(body: String): String = Libcore.parseSubscription(body)

    fun start(engine: Engine, nodeJson: String, fd: Int, optionsJson: String) =
        Libcore.start(engine.id, nodeJson, fd, optionsJson)

    fun stop() = Libcore.stop()

    fun isRunning(): Boolean = Libcore.isRunning()

    fun supports(engine: Engine, nodeJson: String): Boolean = Libcore.supports(engine.id, nodeJson)

    fun buildConfig(engine: Engine, nodeJson: String, optionsJson: String): String =
        Libcore.buildConfig(engine.id, nodeJson, optionsJson)

    fun tcpPing(host: String, port: Int, timeoutMs: Int = 3000): Int = Libcore.tcpPing(host, port, timeoutMs)

    fun logs(): String = Libcore.logs()

    fun xrayVersion(): String = Libcore.xrayVersion()

    fun mihomoVersion(): String = Libcore.mihomoVersion()
}
