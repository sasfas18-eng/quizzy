import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";

const manifest = JSON.parse(readFileSync("dist/.openai/hosting.json", "utf8"));
assert.ok(manifest.project_id, "Missing Sites identity");
assert.ok(manifest.capabilities?.includes("mcp"), "MCP capability missing");
assert.ok(manifest.r2, "Persistent storage binding missing");
assert.ok(existsSync("dist/server/index.js"), "Worker entrypoint missing");
const worker = await import(new URL("../dist/server/index.js", import.meta.url));
assert.equal(typeof worker.default.fetch, "function");
console.log("Worker artifact valid");
