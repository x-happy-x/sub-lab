import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Повтор проверяем в отдельном процессе, и это не прихоть.
 *
 * Паузу между попытками легко написать с `timer.unref()` — и всё будет
 * зелёным: под тест-раннером цикл событий держат его собственные дескрипторы.
 * А вот процесс, которому больше нечего делать, на такой паузе просто выходит:
 * запрос не повторяется, наружу не попадает ни результата, ни ошибки. Ровно
 * это и случилось на живой синхронизации — она молча умирала.
 */
function runScript(source, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--input-type=module", "-e", source],
      { cwd: APP_DIR, timeout: timeoutMs, env: { ...process.env, PROFILE_DIR: "../resources/profiles" } },
      (error, stdout, stderr) => resolve({
        error,
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").trim(),
      }),
    );
  });
}

test("повторы доживают до конца в процессе, которому больше нечего делать", async () => {
  // Порт 1 заведомо закрыт: каждая попытка упрётся в отказ соединения,
  // между ними будет пауза — именно на ней процесс и выходил молча.
  const script = `
    const { fetchRemoteBundle } = await import("./server.js");
    try {
      await fetchRemoteBundle({ remoteUrl: "http://127.0.0.1:1", remoteToken: "tok", profiles: false });
      console.log("НЕОЖИДАННО: запрос удался");
    } catch (e) {
      console.log("ИТОГ: " + e.message);
    }
  `;

  const { error, stdout, stderr } = await runScript(script);
  assert.equal(error, null, `процесс завершился неудачно: ${error?.message || ""} ${stderr}`);
  assert.match(stdout, /^ИТОГ: /, `ожидали итог повторов, получили «${stdout}» ${stderr}`);
  assert.match(stdout, /удалённой панели/);
});
