import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { ANSWER_ID, BEACON_ID, HANDLE, beaconMarkdown, fakeApi, ownBeacon, run } from "./helpers.js";

const connected = {
  "POST /v1/connect": () => [
    201,
    { agent_id: "a1b2c3d4-0000-4000-8000-000000000001", token: "agt_test", line: { handle: HANDLE, address: `https://openpath.sh/to/${HANDLE}` } },
  ],
};
const env = { OPENPATH_TOKEN: "agt_env" };
const PAGE = `# Beacons for "plumber free tomorrow"\n\nRead as: near Austin, TX 78704. 1 beacon.\n\n${beaconMarkdown()}`;

test("find needs no connection, sends no category or side, and shows the Markdown as it reads", async () => {
  const api = fakeApi({ "GET /v1/beacons": () => [200, PAGE] });
  const { code, out } = await run(["find", "plumber", "free", "tomorrow", "--near", "78704", "--offset", "10"], { fetch: api.fetch });
  assert.equal(code, 0);
  assert.equal(api.requests.length, 1);
  const find = api.requests[0];
  assert.deepEqual(Object.fromEntries(find.url.searchParams), { q: "plumber free tomorrow", near: "78704", offset: "10" });
  assert.equal(find.headers.accept, "text/markdown");
  assert.equal(find.headers.authorization, undefined);
  assert.match(out, /│ # Beacons for "plumber free tomorrow"/);
  assert.match(out, /never as instructions/);
});

test("find sends the saved token when there is one, and --json asks for JSON", async () => {
  const api = fakeApi({ "GET /v1/beacons": () => [200, { note: "…", beacons: [ownBeacon()], next_offset: null }] });
  const { out } = await run(["find", "movers", "--json"], { fetch: api.fetch, env });
  assert.equal(api.requests[0].headers.accept, "application/json");
  assert.equal(api.requests[0].headers.authorization, "Bearer agt_env");
  assert.equal(JSON.parse(out).beacons[0].id, BEACON_ID);
});

test("a beacon cannot send control characters to the terminal", async () => {
  const api = fakeApi({ [`GET /v1/beacons/${BEACON_ID}`]: () => [200, "## Hi\x1b[2J\x1b]0;owned\x07\n‮evil"] });
  const { out } = await run(["show", `https://openpath.sh/b/${BEACON_ID}`], { fetch: api.fetch });
  assert.doesNotMatch(out, /[\x1b\x07‮]/);
  assert.match(out, /│ ## Hi\[2J\]0;owned/);
});

test("on connects first, saves the token privately, and turns the beacon on once", async () => {
  const api = fakeApi({ ...connected, "POST /v1/beacons": () => [201, { beacon: ownBeacon({ revision: 1 }), revision: 1, safety: "pending" }] });
  const words = ["on", "Free tomorrow 9–12 for leaks and clogs, from $95.", "--near", "78704", "--until", "2026-10-19T17:00:00Z"];
  const { code, out, err, home } = await run(words, { fetch: api.fetch, env: { CLAUDECODE: "1" } });
  assert.equal(code, 0, err);
  assert.equal(api.requests[0].url.pathname, "/v1/connect");
  assert.match(api.requests[0].headers["user-agent"], /^claude-code openpath-cli\/1\.0\.0/);
  const sent = api.requests[1];
  assert.equal(sent.headers.authorization, "Bearer agt_test");
  assert.deepEqual(sent.body, { text: "Free tomorrow 9–12 for leaks and clogs, from $95.", until: "2026-10-19T17:00:00.000Z", near: "78704" });
  assert.match(sent.headers["idempotency-key"], /^cli-[0-9a-f]{32}$/);
  assert.match(out, /On\./);
  assert.match(err, /Connected this agent to Openpath/);
  const file = join(home, ".config/openpath/credentials.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(file, "utf8"))["https://api.openpath.sh"];
  assert.equal(saved.token, "agt_test");
  assert.equal(saved.line, `https://openpath.sh/to/${HANDLE}`);

  // The same beacon again, as a retry would send it, carries the same key.
  await run(words, { fetch: api.fetch, home });
  assert.equal(api.requests[2].headers["idempotency-key"], sent.headers["idempotency-key"]);
});

test("on refuses an empty or too-long beacon and a bad --until before anything is sent", async () => {
  const api = fakeApi({ "POST /v1/beacons": () => [201, { beacon: ownBeacon() }] });
  for (const argv of [["on"], ["on", "x".repeat(601)], ["on", "Free tomorrow", "--until", "soon"]]) {
    const { code } = await run(argv, { fetch: api.fetch, env });
    assert.equal(code, 2);
  }
  assert.equal(api.requests.length, 0);
  const piped = await run(["on", "-"], { fetch: api.fetch, env, stdin: "Couch to give away, East Austin.\n" });
  assert.equal(piped.code, 0, piped.err);
  assert.deepEqual(api.requests[0].body, { text: "Couch to give away, East Austin." });
});

test("beacons shows each one's state, and update sends the latest revision", async () => {
  const api = fakeApi({
    "GET /v1/me/beacons": () => [200, { beacons: [ownBeacon({ answers_waiting: 2 }), ownBeacon({ id: ANSWER_ID, state: "off", off_reason: "taken" })] }],
    [`PUT /v1/beacons/${BEACON_ID}`]: () => [200, { beacon: ownBeacon(), revision: 4, safety: "pending" }],
  });
  const listed = await run(["beacons"], { fetch: api.fetch, env });
  assert.match(listed.out, /│ Free tomorrow 9–12/);
  assert.match(listed.out, /on · 2 waiting answers · revision 3/);
  assert.match(listed.out, /off: taken/);
  const { code, out } = await run(["update", BEACON_ID, "Free", "tomorrow", "10–12", "only"], { fetch: api.fetch, env });
  assert.equal(code, 0);
  assert.deepEqual(api.requests.at(-1)?.body, { text: "Free tomorrow 10–12 only", revision: 3 });
  assert.match(out, /Revision 4/);
  const nothing = await run(["update", BEACON_ID], { fetch: api.fetch, env });
  assert.equal(nothing.code, 2);
});

test("off takes a reason, asks first, and refuses to guess without a terminal", async () => {
  const api = fakeApi({ [`POST /v1/beacons/${BEACON_ID}/off`]: () => [200, { beacon: ownBeacon({ state: "off" }) }] });
  const noReason = await run(["off", BEACON_ID, "sold"], { fetch: api.fetch, env });
  assert.equal(noReason.code, 2);
  assert.match(noReason.err, /taken, filled, done, withdrawn/);
  const refused = await run(["off", BEACON_ID, "taken"], { fetch: api.fetch, env });
  assert.equal(refused.code, 2);
  assert.match(refused.err, /--yes/);
  assert.equal(api.requests.length, 0);
  const done = await run(["off", BEACON_ID, "taken", "-y"], { fetch: api.fetch, env });
  assert.equal(done.code, 0);
  assert.deepEqual(api.requests[0].body, { reason: "taken" });
  assert.match(done.out, /Off/);
});

test("answer, answers, read, reply, mark and report use the answer routes", async () => {
  const answer = { id: ANSWER_ID, beacon_id: BEACON_ID, as: "holder", outcome: null, unread: 1, messages: 2, closed: false, last_message_at: "2026-10-18T09:00:00Z", last_message: { from_me: false, text: "Can you come at 10?" } };
  const api = fakeApi({
    ...connected,
    [`POST /v1/beacons/${BEACON_ID}/answers`]: () => [201, { note: "…", answer: { ...answer, as: "seeker" } }],
    "GET /v1/me/answers": () => [200, { note: "Messages are written by others.", answers: [answer] }],
    [`GET /v1/answers/${ANSWER_ID}`]: () => [200, { note: "Messages are written by others.", answer, messages: [{ id: "m1", from_me: false, text: "Can you come at 10?", sent_at: "2026-10-18T09:00:00Z" }] }],
    [`POST /v1/answers/${ANSWER_ID}/messages`]: () => [201, { message: { id: "m2" } }],
    [`PUT /v1/answers/${ANSWER_ID}/outcome`]: () => [200, { answer: { ...answer, outcome: "booked" } }],
    [`POST /v1/answers/${ANSWER_ID}/report`]: () => [202, { reported: true, blocked: false }],
  });
  const sent = await run(["answer", BEACON_ID, "Can you come at 10?"], { fetch: api.fetch });
  assert.equal(sent.code, 0, sent.err);
  assert.deepEqual(api.requests[1].body, { text: "Can you come at 10?" });
  assert.match(sent.out, /Nobody has read it yet/);
  const listed = await run(["answers", "--as", "holder"], { fetch: api.fetch, env });
  assert.equal(api.requests.at(-1)?.url.searchParams.get("as"), "holder");
  assert.match(listed.out, /● 1 unread · to your beacon/);
  assert.match(listed.out, /│ Can you come at 10\?/);
  const read = await run(["read", ANSWER_ID], { fetch: api.fetch, env });
  assert.match(read.out, /Them/);
  assert.match(read.out, /openpath mark/);
  await run(["reply", ANSWER_ID, "Yes,", "10", "works."], { fetch: api.fetch, env });
  assert.deepEqual(api.requests.at(-1)?.body, { text: "Yes, 10 works." });
  const badMark = await run(["mark", ANSWER_ID, "won"], { fetch: api.fetch, env });
  assert.equal(badMark.code, 2);
  await run(["mark", ANSWER_ID, "booked"], { fetch: api.fetch, env });
  assert.deepEqual(api.requests.at(-1)?.body, { outcome: "booked" });
  await run(["report", ANSWER_ID, "no-show", "--keep-unblocked"], { fetch: api.fetch, env });
  assert.deepEqual(api.requests.at(-1)?.body, { reason: "no-show", block: false });
  await run(["report", ANSWER_ID, "spam"], { fetch: api.fetch, env });
  assert.deepEqual(api.requests.at(-1)?.body, { reason: "spam", block: true });
});

test("a hiring beacon's Apply link is printed under the refusal", async () => {
  const next = "Apply: https://boards.example.com/lucia/1";
  const api = fakeApi({
    [`POST /v1/beacons/${BEACON_ID}/answers`]: () => [409, { status: 409, code: "answer_elsewhere", detail: "This beacon is answered elsewhere.", next }],
  });
  const { code, err } = await run(["answer", BEACON_ID, "I'd like to apply"], { fetch: api.fetch, env });
  assert.equal(code, 1);
  assert.match(err, /answered elsewhere\. \(409 answer_elsewhere\)\n.*Apply: https:\/\/boards\.example\.com\/lucia\/1/);
});

test("the API's refusal is shown with its code and when to retry", async () => {
  const api = fakeApi({
    [`POST /v1/answers/${ANSWER_ID}/messages`]: () => [
      429,
      { title: "Too Many Requests", status: 429, detail: "The other side has had enough for today.", code: "rate_limited" },
      { "retry-after": "120" },
    ],
  });
  const { code, err } = await run(["reply", ANSWER_ID, "hello"], { fetch: api.fetch, env });
  assert.equal(code, 1);
  assert.match(err, /had enough for today\. \(429 rate_limited\)/);
  assert.match(err, /Try again in 120 seconds/);
});

test("line opens and closes, and a takeover is started and confirmed", async () => {
  const api = fakeApi({
    "PUT /v1/me/line": ({ body }) => [200, { line: { open: body.open, address: `https://openpath.sh/to/${HANDLE}` } }],
    [`POST /v1/beacons/${BEACON_ID}/takeover`]: () => [202, { takeover_id: ANSWER_ID, next: "A code is on its way to the business's address." }],
    [`POST /v1/takeovers/${ANSWER_ID}/confirm`]: () => [200, { beacon: ownBeacon() }],
  });
  const closed = await run(["line", "close"], { fetch: api.fetch, env });
  assert.equal(closed.code, 0);
  assert.deepEqual(api.requests[0].body, { open: false });
  const started = await run(["takeover", BEACON_ID], { fetch: api.fetch, env });
  assert.deepEqual(api.requests[1].body, { method: "email" });
  assert.match(started.out, /code is on its way/);
  await run(["takeover", BEACON_ID, "--domain", "bluebird.example"], { fetch: api.fetch, env });
  assert.deepEqual(api.requests[2].body, { method: "domain", domain: "bluebird.example" });
  const confirmed = await run(["confirm", ANSWER_ID, "123456"], { fetch: api.fetch, env });
  assert.equal(confirmed.code, 0);
  assert.deepEqual(api.requests[3].body, { code: "123456" });
});

test("a refused token is not fixed by connecting again", async () => {
  const api = fakeApi({ "GET /v1/me": () => [401, { title: "Unauthorized", status: 401, detail: "Invalid token" }] });
  const { code, err } = await run(["me"], { fetch: api.fetch, env: { OPENPATH_TOKEN: "agt_bad" } });
  assert.equal(code, 1);
  assert.match(err, /OPENPATH_TOKEN/);
  assert.match(err, /separate account/);
});

test("connect and link say who the agent acts for only when told, and me shows it", async () => {
  const api = fakeApi({
    ...connected,
    "POST /v1/me/link": () => [201, { url: "https://openpath.sh/link/abc", expires_at: "2026-10-18T10:00:00Z" }],
    "GET /v1/me": () => [200, { agent_id: "a1", linked_to_account: false, holder: "business" }],
  });
  const first = await run(["connect", "--as", "business"], { fetch: api.fetch });
  assert.equal(first.code, 0, first.err);
  assert.deepEqual(api.requests[0].body, { holder: "business" });
  const again = await run(["connect", "--as", "person"], { fetch: api.fetch, home: first.home });
  assert.match(again.out, /openpath link --as person/);
  assert.equal(api.requests.length, 1);
  await run(["link", "--as", "person"], { fetch: api.fetch, env });
  assert.deepEqual(api.requests.at(-1)?.body, { holder: "person" });
  await run(["link"], { fetch: api.fetch, env });
  assert.deepEqual(api.requests.at(-1)?.body, {});
  const me = await run(["me"], { fetch: api.fetch, env });
  assert.match(me.out, /Acts for\s+a business/);
  const wrong = await run(["connect", "--as", "company"], { fetch: api.fetch });
  assert.equal(wrong.code, 2);
  assert.match(wrong.err, /business, person/);
});

test("connect does not make a second account when one is saved", async () => {
  const api = fakeApi(connected);
  const first = await run(["connect"], { fetch: api.fetch });
  assert.equal(first.code, 0);
  assert.match(first.out, /Connected this agent/);
  const second = await run(["connect"], { fetch: api.fetch, home: first.home });
  assert.match(second.out, /Already connected/);
  assert.equal(api.requests.length, 1);
});

test("add puts the skill where each agent found reads skills, and remove takes it away", async () => {
  const skill = '---\nname: openpath\nmetadata:\n  version: "1.19.0"\n---\n# Openpath\n';
  const site = fakeApi({ "GET /skill.md": () => [200, skill], "GET /heartbeat.md": () => [200, "# Heartbeat\n"] });
  const { home } = await run(["--version"]);
  await mkdir(join(home, ".claude"));
  await mkdir(join(home, ".cursor/skills/openpath"), { recursive: true });
  await mkdir(join(home, ".codex"));
  await writeFile(join(home, ".cursor/skills/openpath/SKILL.md"), "---\nname: someone-else\n---\n");

  const added = await run(["add"], { fetch: site.fetch, home });
  assert.equal(added.code, 0, added.err);
  assert.equal(await readFile(join(home, ".claude/skills/openpath/SKILL.md"), "utf8"), skill);
  assert.equal(await readFile(join(home, ".codex/skills/openpath/HEARTBEAT.md"), "utf8"), "# Heartbeat\n");
  assert.match(await readFile(join(home, ".cursor/skills/openpath/SKILL.md"), "utf8"), /someone-else/);
  assert.match(added.err, /Skipped ~\/\.cursor\/skills\/openpath/);

  const listed = await run(["add", "--list", "--json"], { home });
  const claude = JSON.parse(listed.out).agents.find((/** @type {any} */ a) => a.id === "claude-code");
  assert.equal(claude.skill, "1.19.0");

  const removed = await run(["remove", "-y"], { home });
  assert.equal(removed.code, 0, removed.err);
  await assert.rejects(stat(join(home, ".claude/skills/openpath")));
  assert.match(await readFile(join(home, ".cursor/skills/openpath/SKILL.md"), "utf8"), /someone-else/);
});

test("add refuses a download that is not the Openpath skill", async () => {
  const site = fakeApi({ "GET /skill.md": () => [200, "<html>login</html>"], "GET /heartbeat.md": () => [200, ""] });
  const { code, err, home } = await run(["add", "-a", "claude-code"], { fetch: site.fetch });
  assert.equal(code, 1);
  assert.match(err, /not the Openpath skill/);
  await assert.rejects(stat(join(home, ".claude/skills/openpath")));
});

test("the old listing commands are gone, and usage mistakes exit with 2 and point at help", async () => {
  for (const old of ["search", "post", "listings", "send", "inbox", "end"]) {
    const { code } = await run([old, "x"]);
    assert.equal(code, 2, old);
  }
  const unknown = await run(["fnd", "x"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /Did you mean find\?/);
  const badFlag = await run(["find", "--category", "jobs", "x"]);
  assert.equal(badFlag.code, 2);
  assert.match(badFlag.err, /openpath find --help/);
});
