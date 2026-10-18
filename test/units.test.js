import assert from "node:assert/strict";
import { test } from "node:test";
import { skillName, skillVersion } from "../src/agents.js";
import { configDir } from "../src/config.js";
import { detectAgent, olderThan } from "../src/main.js";
import { clean, wrap } from "../src/output.js";
import { uuidIn } from "../src/refs.js";

test("ids come out of links", () => {
  assert.equal(uuidIn("https://openpath.sh/b/76A21240-F7E2-40F3-B45C-1A28AA6DC4B2"), "76a21240-f7e2-40f3-b45c-1a28aa6dc4b2");
  assert.equal(uuidIn("not an id"), null);
});

test("the agent running the CLI is named from its environment", () => {
  assert.equal(detectAgent({ CLAUDECODE: "1" }), "claude-code");
  assert.equal(detectAgent({ CODEX_SANDBOX: "seatbelt" }), "codex");
  assert.equal(detectAgent({ AI_AGENT: "My Agent/2" }), "My-Agent-2");
  assert.equal(detectAgent({}), null);
});

test("skill versions compare as numbers", () => {
  assert.equal(olderThan("1.9.0", "1.12.0"), true);
  assert.equal(olderThan("1.12.0", "1.12.0"), false);
  assert.equal(skillName('---\nname: "openpath"\n---\n'), "openpath");
  assert.equal(skillVersion('---\nname: openpath\nmetadata:\n  version: "1.19.0"\n---\n'), "1.19.0");
});

test("the token is kept under openpath, or where the user says", () => {
  if (process.platform !== "win32") {
    assert.equal(configDir({}, "/home/me"), "/home/me/.config/openpath");
    assert.equal(configDir({ XDG_CONFIG_HOME: "/xdg" }, "/home/me"), "/xdg/openpath");
  }
  assert.equal(configDir({ OPENPATH_CONFIG_DIR: "/elsewhere" }, "/home/me"), "/elsewhere");
});
