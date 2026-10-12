import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  cpSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

let root: string;
const env = {
  ...process.env,
  CLOUDFLARE_API_TOKEN: "test-only-token",
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  CLOUDFLARE_D1_DATABASE_ID: "12345678-1234-1234-1234-123456789abc",
  CLOUDFLARE_WORKER_NAME: "meal-planner",
  D1_BACKUP_KEY: "test-only-backup-key-".repeat(3),
};
function run(file: string, args: string[], extra = {}) {
  return spawnSync(file, args, {
    cwd: root,
    env: { ...env, ...extra },
    encoding: "utf8",
  });
}
function stage(name: string, extra = {}) {
  return run("bash", ["scripts/release.sh", name], extra);
}
function trace() {
  return existsSync(join(root, "trace"))
    ? readFileSync(join(root, "trace"), "utf8")
    : "";
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "meal-release-"));
  cpSync(resolve("scripts"), join(root, "scripts"), { recursive: true });
  cpSync(resolve("wrangler.jsonc"), join(root, "wrangler.jsonc"));
  mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist/index.html"), "verified build");
  // An isolated CLI stub records calls and injects faults. Never contacts Cloudflare.
  writeFileSync(
    join(root, "node_modules/.bin/wrangler"),
    `#!/usr/bin/env bash
set -eu
echo "$*" >> trace
if [[ "$1 $2" == 'd1 export' ]]; then
  if [[ "\${FAIL_EXPORT:-}" == 1 ]]; then exit 1; fi
  while [[ "$1" != '--output' ]]; do shift; done
  if [[ "\${EMPTY_EXPORT:-}" == 1 ]]; then touch "$2"; else printf 'CREATE TABLE private_data(id); INSERT INTO private_data VALUES(42);' > "$2"; fi
elif [[ "$1 $2" == 'd1 migrations' && "\${FAIL_MIGRATION:-}" == 1 ]]; then
  exit 1
fi
`,
    { mode: 0o700 },
  );
  expect(run("python3", ["scripts/release-config.py"]).status).toBe(0);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("manual release safety", () => {
  it("targets existing IDs and preserves D1 binding, migration directory and assets", () => {
    const config = JSON.parse(
      readFileSync(join(root, ".release-wrangler.json"), "utf8"),
    );
    expect(config.account_id).toBe(env.CLOUDFLARE_ACCOUNT_ID);
    expect(config.d1_databases[0]).toMatchObject({
      binding: "DB",
      database_id: env.CLOUDFLARE_D1_DATABASE_ID,
      migrations_dir: "migrations",
    });
    expect(config.assets.directory).toBe("./dist");
    rmSync(join(root, ".release-wrangler.json"));
    expect(
      run("python3", ["scripts/release-config.py"], {
        CLOUDFLARE_D1_DATABASE_ID: "",
      }).status,
    ).not.toBe(0);
    expect(existsSync(join(root, ".release-wrangler.json"))).toBe(false);
  });
  it("exports, encrypts, persists, migrates and deploys in order, without plaintext retention", () => {
    expect(stage("backup").status).toBe(0);
    expect(existsSync(join(root, ".release-backup/d1.sql"))).toBe(false);
    expect(existsSync(join(root, ".release-backup/verified.sql"))).toBe(false);
    expect(
      readFileSync(join(root, ".release-backup/d1.sql.enc")).includes(
        Buffer.from("private_data"),
      ),
    ).toBe(false);
    expect(stage("migrate", { BACKUP_ARTIFACT_ID: "123" }).status).toBe(0);
    expect(stage("deploy").status).toBe(0);
    const calls = trace().trim().split("\n");
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("d1 export DB --remote");
    expect(calls[1]).toContain("d1 migrations apply DB --remote");
    expect(calls[2]).toBe("deploy --config .release-wrangler.json");
  });
  it.each([{ FAIL_EXPORT: "1" }, { EMPTY_EXPORT: "1" }])(
    "stops on failed or empty export: %s",
    (fault) => {
      expect(stage("backup", fault).status).not.toBe(0);
      expect(stage("migrate", { BACKUP_ARTIFACT_ID: "123" }).status).not.toBe(
        0,
      );
      expect(stage("deploy").status).not.toBe(0);
      expect(trace()).not.toContain("migrations");
      expect(existsSync(join(root, ".release-backup/d1.sql"))).toBe(false);
    },
  );
  it("rejects absent encryption key before accessing production", () => {
    expect(stage("backup", { D1_BACKUP_KEY: "" }).status).not.toBe(0);
    expect(trace()).toBe("");
  });
  it("blocks migrations without successful artifact upload", () => {
    expect(stage("backup").status).toBe(0);
    expect(stage("migrate").status).not.toBe(0);
    expect(trace()).not.toContain("migrations");
  });
  it("blocks Worker deployment after migration failure", () => {
    expect(stage("backup").status).toBe(0);
    expect(
      stage("migrate", { BACKUP_ARTIFACT_ID: "123", FAIL_MIGRATION: "1" })
        .status,
    ).not.toBe(0);
    expect(stage("deploy").status).not.toBe(0);
    expect(trace()).not.toContain("deploy");
  });
  it("rejects a wrong key and modified ciphertext without writing plaintext", () => {
    expect(stage("backup").status).toBe(0);
    const args = [
      "scripts/backup-crypto.mjs",
      "decrypt",
      ".release-backup/d1.sql.enc",
      "restored.sql",
    ];
    expect(
      run("node", args, { D1_BACKUP_KEY: "wrong-key-".repeat(5) }).status,
    ).not.toBe(0);
    const file = join(root, ".release-backup/d1.sql.enc");
    const bytes = readFileSync(file);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(file, bytes);
    expect(run("node", args).status).not.toBe(0);
    expect(existsSync(join(root, "restored.sql"))).toBe(false);
  });
});
