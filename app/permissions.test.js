import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function randomToken(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString("hex")}`;
}

async function importStoreModule() {
  return import(`./sqlite-store.js?case=${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

async function importShortLinksModule() {
  return import(`./short-links.js?case=${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

test("short-link permissions deny anonymous and unrelated users by default", async (t) => {
  const ownerUsername = randomToken("owner");
  const strangerUsername = randomToken("stranger");
  const shortLinkId = randomToken("link");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sub-lab-perms-"));
  process.env.SUB_LAB_DATA_DIR = tempDir;
  t.after(() => {
    delete process.env.SUB_LAB_DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const {
    createShortLinkRow,
    createUser,
    getShortLinkPermissions,
  } = await importStoreModule();

  await createUser({ username: ownerUsername, password: "secret123", role: "user" });
  await createUser({ username: strangerUsername, password: "secret123", role: "user" });
  await createShortLinkRow(shortLinkId, {
    title: "Private sub",
    ownerUsername,
    params: {
      endpoint: "last",
      output: "yml",
      sub_url: "https://example.com/sub",
    },
  });

  const anonymous = await getShortLinkPermissions(shortLinkId, { username: "", role: "user" });
  assert.equal(anonymous?.canView, false);
  assert.equal(anonymous?.canEdit, false);
  assert.equal(anonymous?.accessLevel, "");

  const stranger = await getShortLinkPermissions(shortLinkId, { username: strangerUsername, role: "user" });
  assert.equal(stranger?.canView, false);
  assert.equal(stranger?.canEdit, false);
  assert.equal(stranger?.accessLevel, "");

  const owner = await getShortLinkPermissions(shortLinkId, { username: ownerUsername, role: "user" });
  assert.equal(owner?.canView, true);
  assert.equal(owner?.canEdit, true);
  assert.equal(owner?.accessLevel, "edit");
});

test("public short-link lookup allows anonymous direct access", async (t) => {
  const ownerUsername = randomToken("owner");
  const shortLinkId = randomToken("link");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sub-lab-public-link-"));
  process.env.SUB_LAB_DATA_DIR = tempDir;
  t.after(() => {
    delete process.env.SUB_LAB_DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { createShortLinkRow, createUser } = await importStoreModule();
  const { getPublicShortLink } = await importShortLinksModule();

  await createUser({ username: ownerUsername, password: "secret123", role: "user" });
  await createShortLinkRow(shortLinkId, {
    title: "Public share",
    ownerUsername,
    params: {
      endpoint: "sub",
      output: "raw",
      sub_url: "https://example.com/sub",
    },
  });

  const found = await getPublicShortLink(shortLinkId);
  assert.equal(found?.ok, true);
  assert.equal(found?.link?.id, shortLinkId);
  assert.equal(found?.link?.params?.endpoint, "sub");
  assert.equal(found?.link?.params?.sub_url, "https://example.com/sub");
});

test("hidden short-link lookup denies public access but keeps owner access", async (t) => {
  const ownerUsername = randomToken("owner");
  const shortLinkId = randomToken("link");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sub-lab-hidden-link-"));
  process.env.SUB_LAB_DATA_DIR = tempDir;
  t.after(() => {
    delete process.env.SUB_LAB_DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { createShortLinkRow, createUser, getShortLinkPermissions } = await importStoreModule();
  const { getPublicShortLink } = await importShortLinksModule();

  await createUser({ username: ownerUsername, password: "secret123", role: "user" });
  await createShortLinkRow(shortLinkId, {
    title: "Hidden share",
    ownerUsername,
    hidden: true,
    params: {
      endpoint: "sub",
      output: "raw",
      sub_url: "https://example.com/sub",
    },
  });

  const publicLookup = await getPublicShortLink(shortLinkId);
  assert.equal(publicLookup?.ok, false);
  assert.equal(publicLookup?.status, 404);

  const owner = await getShortLinkPermissions(shortLinkId, { username: ownerUsername, role: "user" });
  assert.equal(owner?.canView, true);
  assert.equal(owner?.link?.hidden, true);
});

test("short-link update can rename id and preserve related access", async (t) => {
  const ownerUsername = randomToken("owner");
  const viewerUsername = randomToken("viewer");
  const oldId = randomToken("old");
  const newId = randomToken("new");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sub-lab-rename-link-"));
  process.env.SUB_LAB_DATA_DIR = tempDir;
  t.after(() => {
    delete process.env.SUB_LAB_DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { createShortLinkRow, createUser, getShortLinkRow, renameShortLinkRow, replaceShortLinkAccess, listShortLinkAccess } = await importStoreModule();

  await createUser({ username: ownerUsername, password: "secret123", role: "user" });
  await createUser({ username: viewerUsername, password: "secret123", role: "user" });
  await createShortLinkRow(oldId, {
    title: "Renamed share",
    ownerUsername,
    params: {
      endpoint: "sub",
      output: "raw",
      sub_url: "https://example.com/sub",
    },
  });
  await replaceShortLinkAccess(oldId, [{ username: viewerUsername, accessLevel: "view" }]);

  const renamed = await renameShortLinkRow(oldId, newId);
  assert.equal(renamed.id, newId);

  const oldLink = await getShortLinkRow(oldId);
  assert.equal(oldLink, null);

  const newLink = await getShortLinkRow(newId);
  assert.equal(newLink.id, newId);
  const grants = await listShortLinkAccess(newId);
  assert.equal(grants.length, 1);
  assert.equal(grants[0].username, viewerUsername);
});

test("account roles map to app roles without granting admin by default", async () => {
  const { authUserFromAccount, SESSION_COOKIE, ACCOUNT_SESSION_COOKIE } = await import("./server.js");

  const viewer = authUserFromAccount({ login: "Viewer", name: "V", access: { sub_mirror: { role: "viewer" } } });
  assert.equal(viewer.username, "viewer");
  assert.equal(viewer.role, "user");
  assert.equal(viewer.accountRole, "viewer");
  assert.equal(viewer.canEdit, false);

  const editor = authUserFromAccount({ login: "editor", access: { sub_mirror: { role: "editor" } } });
  assert.equal(editor.role, "user");
  assert.equal(editor.canEdit, true);

  const admin = authUserFromAccount({ login: "admin", access: { sub_mirror: { role: "admin" } } });
  assert.equal(admin.role, "admin");
  assert.equal(admin.canEdit, true);

  // Роль в другом приложении сюда не переносится.
  assert.equal(authUserFromAccount({ login: "x", access: { bigfam: { role: "admin" } } }), null);
  assert.equal(authUserFromAccount({ login: "x", access: {} }), null);
  assert.equal(authUserFromAccount(null), null);

  // Cookie браузера не совпадает с общей cookie внутреннего API account:
  // иначе вход в соседнее приложение подменял бы пользователя здесь.
  assert.notEqual(SESSION_COOKIE, ACCOUNT_SESSION_COOKIE);
  assert.equal(ACCOUNT_SESSION_COOKIE, "kartoteka_session");
});
