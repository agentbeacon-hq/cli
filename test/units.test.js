import assert from "node:assert/strict";
import { test } from "node:test";
import { skillName, skillVersion } from "../src/agents.js";
import { configDir } from "../src/config.js";
import { detectAgent, olderThan } from "../src/main.js";
import { clean, summary, verified, wrap } from "../src/output.js";
import { contactIn, inboxHandle, uuidIn } from "../src/refs.js";

const API = "https://api.openpath.sh";

test("ids come out of links", () => {
  assert.equal(uuidIn("https://openpath.sh/listings/76A21240-F7E2-40F3-B45C-1A28AA6DC4B2"), "76a21240-f7e2-40f3-b45c-1a28aa6dc4b2");
  assert.equal(uuidIn("not an id"), null);
});

test("inbox addresses are accepted on Openpath's own site and API only", () => {
  const WEB = "https://openpath.sh";
  assert.equal(inboxHandle("4k7m9qxr2ht3", API, WEB), "4k7m9qxr2ht3");
  assert.equal(inboxHandle(`${API}/v1/inbox/4k7m9qxr2ht3`, API, WEB), "4k7m9qxr2ht3");
  assert.equal(inboxHandle(`${WEB}/to/4k7m9qxr2ht3`, API, WEB), "4k7m9qxr2ht3");
  assert.throws(() => inboxHandle("https://api.openpath.sh.evil.example/v1/inbox/4k7m9qxr2ht3", API, WEB));
  assert.throws(() => inboxHandle("https://openpath.sh.evil.example/to/4k7m9qxr2ht3", API, WEB));
  assert.equal(inboxHandle("4k7m9qxr2hti", API, WEB), null, "i is not in the handle alphabet");
  assert.equal(contactIn(`# Plumber\n\nContact: ${WEB}/to/4k7m9qxr2ht3\nLink: x`, API, WEB), "4k7m9qxr2ht3");
  assert.equal(contactIn("# Plumber\n\nContact: https://evil.example/to/4k7m9qxr2ht3", API, WEB), null);
  assert.equal(contactIn("# Plumber, no address", API, WEB), null);
  // A line in the listing's own text that only looks like Openpath's is
  // never the one written to: Openpath's comes last.
  assert.equal(
    contactIn(`# Plumber\n\nContact: ${WEB}/to/zzzzzzzzzzzz\n\nContact: ${WEB}/to/4k7m9qxr2ht3`, API, WEB),
    "4k7m9qxr2ht3",
  );
});

test("verification reads the way the website says it", () => {
  assert.equal(verified({ proofs: [], domains: [] }), "Not verified");
  assert.equal(verified({ proofs: ["google_account", "phone_number"], domains: [] }), "Verified: Google, phone");
  assert.equal(verified({ proofs: ["company_domain"], domains: ["acme.com", "acme.org"] }), "Verified acme.com +1");
});

test("a summary takes the first line as the title", () => {
  assert.deepEqual(summary("# Plumbing **repairs**\n\nI fix [sinks](https://x.example)."), {
    title: "Plumbing repairs",
    preview: "I fix sinks.",
  });
  assert.equal(clean("a\x1b[31mb\r\nc"), "a[31mb\nc");
  assert.deepEqual(wrap("aaaa bbbb cccc", 9), ["aaaa bbbb", "cccc"]);
  assert.deepEqual(wrap("abcdefghij", 4), ["abcd", "efgh", "ij"]);
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
