#!/usr/bin/env bash
set -euo pipefail

# Check packaging without starting the app, services, or any network traffic.
image="${1:?Usage: scripts/check-runtime-image.sh IMAGE}"
docker run --rm --network none --entrypoint node "$image" --input-type=module -e '
import assert from "node:assert/strict";
import fs from "node:fs";
const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
assert.equal(process.env.NODE_ENV, "production");
assert.ok(fs.existsSync("dist/index.js"), "compiled entrypoint missing");
for (const name of Object.keys(manifest.devDependencies ?? {})) {
  assert.equal(fs.existsSync(`node_modules/${name}`), false, `dev dependency shipped: ${name}`);
}
for (const name of Object.keys(manifest.dependencies ?? {})) {
  await import(name);
}
console.log("Runtime image contains compiled app and loadable production dependencies only");
'
