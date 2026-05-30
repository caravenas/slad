import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createCacheStore,
  resolveCacheEntriesDir,
  resolveCacheEntryPath,
  resolveCacheObjectMetadataPath,
  resolveCacheObjectDir,
  resolveProjectCacheDir,
  resolveProjectCacheMetadataPath,
  resolveCacheRoot,
} from "./store.js";

test("resolveCacheRoot keeps cache outside src tree by default", () => {
  const root = resolveCacheRoot();

  assert.equal(root, path.resolve(os.homedir(), ".slad-os", "cache", "v1"));
  assert.equal(path.basename(root), "v1");
  assert.notEqual(path.dirname(path.dirname(path.dirname(root))), process.cwd());
});

test("different projects resolve to different cache paths", () => {
  const rootDir = path.join(os.tmpdir(), "slad-cache-layout");
  const plannerProjectDir = resolveProjectCacheDir({
    rootDir,
    projectId: "acme/app",
  });
  const plannerDir = resolveCacheObjectDir({
    rootDir,
    projectId: "acme/app",
    objectType: "planner",
  });
  const otherPlannerDir = resolveCacheObjectDir({
    rootDir,
    projectId: "acme/app-fork",
    objectType: "planner",
  });
  const agentDir = resolveCacheObjectDir({
    rootDir,
    projectId: "acme/app",
    objectType: "agents",
  });

  assert.notEqual(plannerDir, otherPlannerDir);
  assert.notEqual(plannerDir, agentDir);
  assert.match(plannerProjectDir, new RegExp(`\\${path.sep}projects\\${path.sep}`));
  assert.match(plannerDir, new RegExp(`\\${path.sep}projects\\${path.sep}`));
  assert.match(plannerDir, new RegExp(`\\${path.sep}objects\\${path.sep}`));
});

test("filesystem cache persists entries under project and object namespaces", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-cache-store-"));
  const store = createCacheStore<{ value: number }>({
    rootDir,
    projectId: "acme/app",
    objectType: "planner",
  });

  store.set("latest-plan", { value: 42 });

  const filePath = resolveCacheEntryPath({
    rootDir,
    projectId: "acme/app",
    objectType: "planner",
    key: "latest-plan",
  });
  const projectMetadataPath = resolveProjectCacheMetadataPath({
    rootDir,
    projectId: "acme/app",
  });
  const objectMetadataPath = resolveCacheObjectMetadataPath({
    rootDir,
    projectId: "acme/app",
    objectType: "planner",
  });
  const entriesDir = resolveCacheEntriesDir({
    rootDir,
    projectId: "acme/app",
    objectType: "planner",
  });
  const persistedProjectMetadata = JSON.parse(fs.readFileSync(projectMetadataPath, "utf8")) as {
    gcPolicy: string;
    gcNotes: string;
  };
  const persistedEntry = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
    expiresAt?: number;
  };

  assert.deepEqual(store.get("latest-plan"), { value: 42 });
  assert.equal(fs.existsSync(filePath), true);
  assert.equal(fs.existsSync(projectMetadataPath), true);
  assert.equal(fs.existsSync(objectMetadataPath), true);
  assert.equal(path.dirname(filePath), entriesDir);
  assert.match(filePath, new RegExp(`\\${path.sep}projects\\${path.sep}`));
  assert.match(filePath, new RegExp(`\\${path.sep}objects\\${path.sep}`));
  assert.match(filePath, new RegExp(`\\${path.sep}entries\\${path.sep}`));
  assert.equal(persistedProjectMetadata.gcPolicy, "manual_delete_only");
  assert.match(persistedProjectMetadata.gcNotes, /delete projects\/<projectId>\//);
  assert.equal("expiresAt" in persistedEntry, false);
});

test("different projectIds write to isolated on-disk namespaces", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-cache-isolation-"));
  const firstStore = createCacheStore<{ owner: string }>({
    rootDir,
    projectId: "acme/app",
    objectType: "planner",
  });
  const secondStore = createCacheStore<{ owner: string }>({
    rootDir,
    projectId: "acme/app-fork",
    objectType: "planner",
  });

  firstStore.set("latest-plan", { owner: "first" });
  secondStore.set("latest-plan", { owner: "second" });

  const firstPath = resolveCacheEntryPath({
    rootDir,
    projectId: "acme/app",
    objectType: "planner",
    key: "latest-plan",
  });
  const secondPath = resolveCacheEntryPath({
    rootDir,
    projectId: "acme/app-fork",
    objectType: "planner",
    key: "latest-plan",
  });

  assert.notEqual(firstPath, secondPath);
  assert.notEqual(path.dirname(path.dirname(path.dirname(firstPath))), path.dirname(path.dirname(path.dirname(secondPath))));
  assert.deepEqual(firstStore.get("latest-plan"), { owner: "first" });
  assert.deepEqual(secondStore.get("latest-plan"), { owner: "second" });
});

test("projects cannot read or overwrite each other's persisted cache entries", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-cache-cross-project-"));
  const firstStore = createCacheStore<{ owner: string; revision: number }>({
    rootDir,
    projectId: "acme/app",
    objectType: "planner",
  });
  const secondStore = createCacheStore<{ owner: string; revision: number }>({
    rootDir,
    projectId: "acme/app-fork",
    objectType: "planner",
  });

  firstStore.set("latest-plan", { owner: "first", revision: 1 });

  assert.deepEqual(firstStore.get("latest-plan"), { owner: "first", revision: 1 });
  assert.equal(secondStore.get("latest-plan"), undefined);

  secondStore.set("latest-plan", { owner: "second", revision: 2 });

  assert.deepEqual(firstStore.get("latest-plan"), { owner: "first", revision: 1 });
  assert.deepEqual(secondStore.get("latest-plan"), { owner: "second", revision: 2 });
});

test("project cache namespaces stay inspectable and can be deleted manually without touching sources or other projects", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "slad-cache-manual-delete-"));
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "slad-cache-source-"));
  const sourceFile = path.join(sourceRoot, "src", "app.ts");
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, "export const value = 1;\n", "utf8");

  const firstStore = createCacheStore<{ owner: string }>({
    rootDir,
    projectId: "acme/app",
    objectType: "planner",
  });
  const secondStore = createCacheStore<{ owner: string }>({
    rootDir,
    projectId: "acme/app-fork",
    objectType: "planner",
  });

  firstStore.set("latest-plan", { owner: "first" });
  secondStore.set("latest-plan", { owner: "second" });

  const firstProjectDir = resolveProjectCacheDir({
    rootDir,
    projectId: "acme/app",
  });
  const secondProjectDir = resolveProjectCacheDir({
    rootDir,
    projectId: "acme/app-fork",
  });
  const firstEntriesDir = resolveCacheEntriesDir({
    rootDir,
    projectId: "acme/app",
    objectType: "planner",
  });
  const firstEntryPath = resolveCacheEntryPath({
    rootDir,
    projectId: "acme/app",
    objectType: "planner",
    key: "latest-plan",
  });

  assert.equal(fs.existsSync(firstProjectDir), true);
  assert.equal(fs.existsSync(secondProjectDir), true);
  assert.equal(fs.readdirSync(rootDir).includes("projects"), true);
  assert.equal(fs.existsSync(firstEntriesDir), true);
  assert.equal(path.dirname(firstEntryPath), firstEntriesDir);

  fs.rmSync(firstProjectDir, { recursive: true, force: true });

  assert.equal(fs.existsSync(firstProjectDir), false);
  assert.equal(firstStore.get("latest-plan"), undefined);
  assert.deepEqual(secondStore.get("latest-plan"), { owner: "second" });
  assert.equal(fs.readFileSync(sourceFile, "utf8"), "export const value = 1;\n");
  assert.equal(fs.existsSync(sourceFile), true);
});
