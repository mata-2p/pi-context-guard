import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

test("pi manifest paths exist and the host package is only a peer dependency", () => {
  for (const path of pkg.pi.extensions) assert.ok(existsSync(join(root, path)), path);
  assert.equal(pkg.peerDependencies["@earendil-works/pi-coding-agent"], "*");
  assert.equal(pkg.dependencies?.["@earendil-works/pi-coding-agent"], undefined);
  assert.ok(pkg.keywords.includes("pi-package"));
  assert.ok(pkg.files.every((file) => !file.includes("test")));
});

test("the changelog has a heading for the package version", () => {
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  assert.ok(changelog.includes(`## [${pkg.version}]`), `CHANGELOG.md lacks ## [${pkg.version}]`);
});
