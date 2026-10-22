import assert from "node:assert/strict";
import { test } from "node:test";
import { skillName, skillVersion } from "../src/agents.js";
import { configDir } from "../src/config.js";
import { detectAgent, outOfDate } from "../src/main.js";
import { ago, clean, wrap } from "../src/output.js";
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

test("a skill copy of any other version is out of date, a lower one too", () => {
  assert.equal(outOfDate("1.9.0", "1.12.0"), true);
  assert.equal(outOfDate("3.2.0", "0.1.0"), true);
  assert.equal(outOfDate("0.1.0", "0.1.0"), false);
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

test("a live location's age reads in seconds, then minutes", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  assert.equal(ago("2026-10-22T11:59:52Z", now), "updated 8 seconds ago");
  assert.equal(ago("2026-10-22T12:00:00Z", now), "updated 1 second ago");
  assert.equal(ago("2026-10-22T11:59:00Z", now), "updated 1 minute ago");
  assert.equal(ago("2026-10-22T11:58:01Z", now), "updated 1 minute ago");
  assert.equal(ago("2026-10-22T11:58:00Z", now), "updated 2 minutes ago");
});
