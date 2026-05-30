import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  resolveProjectId,
  resolveProjectMetadataPath,
} from "./project-id.js";

process.env.SLAD_PROJECT_REGISTRATIONS_ROOT = fs.mkdtempSync(
  path.join(os.tmpdir(), "slad-project-registrations-"),
);

test("git projects persist a stable projectId across repeated resolutions and folder renames", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "slad-project-id-git-"));
  const repoRoot = path.join(workspace, "repo");
  const nestedDir = path.join(repoRoot, "packages", "planner");

  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, ".git", "config"),
    '[remote "origin"]\n  url = git@github.com:acme/slad.git\n',
    "utf8",
  );

  const first = resolveProjectId({ cwd: nestedDir });
  const second = resolveProjectId({ cwd: nestedDir });

  assert.equal(first.projectKind, "git");
  assert.equal(first.projectRoot, repoRoot);
  assert.equal(first.projectId, second.projectId);
  assert.equal(fs.existsSync(resolveProjectMetadataPath(repoRoot)), true);

  const movedRoot = path.join(workspace, "repo-renamed");
  fs.renameSync(repoRoot, movedRoot);

  const moved = resolveProjectId({ cwd: path.join(movedRoot, "packages", "planner") });
  assert.equal(moved.projectRoot, movedRoot);
  assert.equal(moved.projectId, first.projectId);
});

test("non-git directories persist a stable local projectId and isolate siblings", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "slad-project-id-dir-"));
  const firstDir = path.join(workspace, "first");
  const secondDir = path.join(workspace, "second");

  fs.mkdirSync(firstDir, { recursive: true });
  fs.mkdirSync(secondDir, { recursive: true });

  const first = resolveProjectId({ cwd: firstDir });
  const firstRepeat = resolveProjectId({ cwd: firstDir });
  const second = resolveProjectId({ cwd: secondDir });

  assert.equal(first.projectKind, "directory");
  assert.equal(first.projectRoot, firstDir);
  assert.equal(first.projectId, firstRepeat.projectId);
  assert.notEqual(first.projectId, second.projectId);
  assert.equal(fs.existsSync(resolveProjectMetadataPath(firstDir)), true);
  assert.equal(fs.existsSync(resolveProjectMetadataPath(secondDir)), true);
});

test("non-git project markers and persisted metadata keep nested directories stable", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "slad-project-id-local-root-"));
  const projectRoot = path.join(workspace, "app");
  const nestedDir = path.join(projectRoot, "src", "features");

  fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "package.json"), '{ "name": "local-app" }\n', "utf8");

  const first = resolveProjectId({ cwd: nestedDir });
  const second = resolveProjectId({ cwd: path.join(projectRoot, "src") });

  assert.equal(first.projectKind, "directory");
  assert.equal(first.projectRoot, projectRoot);
  assert.equal(first.projectId, second.projectId);
  assert.equal(fs.existsSync(resolveProjectMetadataPath(projectRoot)), true);

  const movedRoot = path.join(workspace, "app-renamed");
  fs.renameSync(projectRoot, movedRoot);

  const moved = resolveProjectId({ cwd: path.join(movedRoot, "src", "features") });
  assert.equal(moved.projectRoot, movedRoot);
  assert.equal(moved.projectId, first.projectId);
});

test("monorepo packages under the same git root resolve to one shared projectId", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "slad-project-id-monorepo-"));
  const repoRoot = path.join(workspace, "repo");
  const packageA = path.join(repoRoot, "packages", "cli");
  const packageB = path.join(repoRoot, "packages", "agents");

  fs.mkdirSync(path.join(repoRoot, ".git"), { recursive: true });
  fs.mkdirSync(packageA, { recursive: true });
  fs.mkdirSync(packageB, { recursive: true });

  const first = resolveProjectId({ cwd: packageA });
  const second = resolveProjectId({ cwd: packageB });

  assert.equal(first.projectRoot, repoRoot);
  assert.equal(second.projectRoot, repoRoot);
  assert.equal(first.projectId, second.projectId);
});
