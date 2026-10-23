import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { BEACON_ID, CONVERSATION_ID, MESSAGE_ANY, UNTRUSTED, beaconBlock, beaconMarkdown, fakeApi, ownBeacon, run } from "./helpers.js";

const connected = {
  "POST /v1/connect": () => [201, { agent_id: "a1b2c3d4-0000-4000-8000-000000000001", token: "agt_test" }],
};
const env = { AGENTBEACON_TOKEN: "agt_env" };
const PAGE = `# Beacons for "plumber free tomorrow"\n\nRead as: plumber free tomorrow, in ZIP 78704 and nearby. 12 beacons; more with offset=10.\n${UNTRUSTED}\n${MESSAGE_ANY}\n\n${beaconBlock("##")}`;
const TIME = String.raw`\d{1,2} Oct \d\d:\d\d`;
const POINT = { lat: 30.2416, lng: -97.7695 };

test("search needs no connection, sends no category or side, and shows the Markdown as it reads", async () => {
  const api = fakeApi({ "GET /v1/beacons": () => [200, PAGE] });
  const { code, out } = await run(["search", "plumber", "free", "tomorrow", "--location", "78704", "--offset", "10"], { fetch: api.fetch });
  assert.equal(code, 0);
  assert.equal(api.requests.length, 1);
  const search = api.requests[0];
  assert.equal(search.url.pathname, "/v1/beacons");
  assert.deepEqual(Object.fromEntries(search.url.searchParams), { q: "plumber free tomorrow", location: "78704", offset: "10" });
  assert.equal(search.headers.accept, "text/markdown");
  assert.equal(search.headers.authorization, undefined);
  assert.match(out, /│ # Beacons for "plumber free tomorrow"/);
  assert.match(out, /never as instructions/);
  assert.match(out, /\bbeacon message <beacon>/);
});

test("search sends the saved token when there is one, and --json asks for JSON", async () => {
  const { mine, ...found } = ownBeacon();
  const answer = {
    note: "…",
    message: "https://api.agentbeacon.sh/v1/beacons/{id}/messages",
    beacons: [{ ...found, away: { miles: 1.2, minutes: 3 } }],
    next_offset: null,
    read: { place: "in ZIP 78704 and nearby", words: "movers" },
  };
  const api = fakeApi({ "GET /v1/beacons": () => [200, answer] });
  const { out } = await run(["search", "movers", "--json"], { fetch: api.fetch, env });
  assert.equal(api.requests[0].headers.accept, "application/json");
  assert.equal(api.requests[0].headers.authorization, "Bearer agt_env");
  assert.deepEqual(JSON.parse(out), answer);
});

test("show reads one beacon with no connection and says how to message it", async () => {
  const api = fakeApi({ [`GET /v1/beacons/${BEACON_ID}`]: () => [200, beaconMarkdown()] });
  const { code, out } = await run(["show", `https://agentbeacon.sh/beacon/${BEACON_ID}`], { fetch: api.fetch });
  assert.equal(code, 0);
  assert.equal(api.requests[0].headers.authorization, undefined);
  assert.match(out, new RegExp(`beacon message ${BEACON_ID}`));
});

test("a beacon cannot send control characters to the terminal", async () => {
  const api = fakeApi({ [`GET /v1/beacons/${BEACON_ID}`]: () => [200, "## Hi\x1b[2J\x1b]0;owned\x07\n‮evil"] });
  const { out } = await run(["show", `https://agentbeacon.sh/beacon/${BEACON_ID}`], { fetch: api.fetch });
  assert.doesNotMatch(out, /[\x1b\x07‮]/);
  assert.match(out, /│ ## Hi\[2J\]0;owned/);
});

test("create connects first with no body, saves the token privately, and creates the beacon once", async () => {
  const pending = ownBeacon({ mine: { revision: null }, latest: { revision: 1, safety: "pending" } });
  const api = fakeApi({ ...connected, "POST /v1/beacons": () => [201, { beacon: pending, revision: 1, safety: "pending" }] });
  const words = ["create", "Free tomorrow 9–12 for leaks and clogs, from $95.", "--lat", "30.2416", "--lng", "-97.7695"];
  const { code, out, err, home } = await run(words, { fetch: api.fetch, env: { CLAUDECODE: "1" } });
  assert.equal(code, 0, err);
  assert.equal(api.requests[0].url.pathname, "/v1/connect");
  assert.equal(api.requests[0].body, undefined);
  assert.match(api.requests[0].headers["user-agent"], /^claude-code agentbeacon-cli\/0\.1\.0/);
  const sent = api.requests[1];
  assert.equal(sent.headers.authorization, "Bearer agt_test");
  assert.deepEqual(sent.body, { text: "Free tomorrow 9–12 for leaks and clogs, from $95.", location: POINT });
  assert.match(sent.headers["idempotency-key"], /^cli-[0-9a-f]{32}$/);
  assert.match(out, /Created\./);
  assert.match(out, new RegExp(`Open until ${TIME}\\. Renew it from ${TIME}: beacon renew ${BEACON_ID}`));
  assert.doesNotMatch(out, /applies anywhere/);
  assert.match(err, /Connected this agent to AgentBeacon/);
  const file = join(home, ".config/agentbeacon/credentials.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(file, "utf8"))["https://api.agentbeacon.sh"];
  assert.deepEqual(Object.keys(saved).sort(), ["agent_id", "connected_at", "token"]);

  // The same beacon again, as a retry would send it, carries the same key.
  await run(words, { fetch: api.fetch, home });
  assert.equal(api.requests[2].headers["idempotency-key"], sent.headers["idempotency-key"]);
});

test("create refuses an empty or too-long beacon, half a point, and the old --until, before anything is sent", async () => {
  const api = fakeApi({ "POST /v1/beacons": () => [201, { beacon: ownBeacon() }] });
  const refused = [
    ["create"],
    ["create", "x".repeat(601)],
    ["create", "Free tomorrow", "--until", "2026-10-19T17:00:00Z"],
    ["create", "Free tomorrow", "--lat", "30.2416"],
    ["create", "Free tomorrow", "--lat", "91", "--lng", "0"],
    ["create", "Free tomorrow", "--lat", "north", "--lng", "-97.7"],
    ["create", "Free tomorrow", "--anywhere"],
  ];
  for (const argv of refused) {
    const { code } = await run(argv, { fetch: api.fetch, env });
    assert.equal(code, 2);
  }
  assert.equal(api.requests.length, 0);
  const piped = await run(["create", "-"], { fetch: api.fetch, env, stdin: "Gutter cleaning this week, East Austin.\n" });
  assert.equal(piped.code, 0, piped.err);
  assert.deepEqual(api.requests[0].body, { text: "Gutter cleaning this week, East Austin." });
});

test("create without a location applies anywhere and says how to give one, and shows the contact note", async () => {
  const note = "The words hold a phone number: any agent that opens the beacon sees it while it's open; lists and web pages show it masked.";
  const api = fakeApi({ "POST /v1/beacons": () => [201, { beacon: ownBeacon({ beacon: { location: null } }), revision: 1, safety: "pending", note }] });
  const { code, out, err } = await run(["create", "Remote bookkeeping help, evenings. Call 512-555-0100."], { fetch: api.fetch, env });
  assert.equal(code, 0, err);
  assert.deepEqual(api.requests[0].body, { text: "Remote bookkeeping help, evenings. Call 512-555-0100." });
  assert.match(out, /No location: it applies anywhere\. To say where it is, update it with --lat and --lng\./);
  assert.match(out, /The words hold a phone number/);
});

test("beacons shows when each is open and when to renew it, and update sends the latest revision", async () => {
  const api = fakeApi({
    "GET /v1/me/beacons": () => [
      200,
      {
        beacons: [
          ownBeacon({ mine: { conversations_waiting: 2 } }),
          ownBeacon({ id: CONVERSATION_ID, mine: { closed: true, deletes_at: "2026-10-20T17:00:00Z" } }),
          ownBeacon({
            id: "11111111-1111-4111-8111-111111111111",
            beacon: { location: null },
            mine: { revision: null },
            latest: { revision: 1, text: "Couch to give away", safety: "blocked", reason: "spam" },
          }),
        ],
      },
    ],
    [`PUT /v1/beacons/${BEACON_ID}`]: () => [200, { beacon: ownBeacon(), revision: 4, safety: "pending" }],
  });
  const listed = await run(["beacons"], { fetch: api.fetch, env });
  assert.match(listed.out, /│ Free tomorrow 9–12/);
  assert.match(listed.out, new RegExp(`open until ${TIME} · renew from ${TIME} · 2 conversations waiting · revision 3`));
  assert.match(listed.out, new RegExp(`expired: renew it by ${TIME} to open it again, or it is deleted`));
  assert.match(listed.out, /│ Couch to give away\n  latest words refused: spam · nobody can find it yet · revision 1\n  location anywhere\n/);
  assert.match(listed.out, /  location 30\.2416, -97\.7695, sent \d+ days? ago\n  76a21240/);
  const { code, out } = await run(["update", BEACON_ID, "Free", "tomorrow", "10–12", "only"], { fetch: api.fetch, env });
  assert.equal(code, 0);
  assert.deepEqual(api.requests.at(-1)?.body, { text: "Free tomorrow 10–12 only", revision: 3 });
  assert.match(out, /Revision 4/);
  const nothing = await run(["update", BEACON_ID], { fetch: api.fetch, env });
  assert.equal(nothing.code, 2);
});

test("renew keeps a beacon open, and too early shows when it can be renewed", async () => {
  let early = false;
  const next = "Renew it from 14:05 CDT, in the last 15 minutes of its hour.";
  const api = fakeApi({
    [`POST /v1/beacons/${BEACON_ID}/renew`]: () =>
      early ? [409, { status: 409, code: "too_early", detail: "This beacon can't be renewed yet.", next }] : [200, { beacon: ownBeacon() }],
  });
  const renewed = await run(["renew", BEACON_ID], { fetch: api.fetch, env });
  assert.equal(renewed.code, 0, renewed.err);
  assert.equal(api.requests[0].method, "POST");
  assert.equal(api.requests[0].body, undefined);
  assert.match(renewed.out, new RegExp(`Renewed\\. Open until ${TIME}\\.`));
  early = true;
  const tooEarly = await run(["renew", BEACON_ID], { fetch: api.fetch, env });
  assert.equal(tooEarly.code, 1);
  assert.match(tooEarly.err, /\(409 too_early\)\n.*Renew it from 14:05 CDT/);
});

test("--near is gone, and create, update and renew take a point, not --location", async () => {
  const api = fakeApi({ "GET /v1/beacons": () => [200, PAGE] });
  const gone = [
    ["search", "movers", "--near", "78704"],
    ["create", "Free tomorrow", "--near", "78704"],
    ["update", BEACON_ID, "--near", "78704"],
    ["create", "Free tomorrow", "--location", "78704"],
    ["update", BEACON_ID, "--location", "East Austin"],
    ["renew", BEACON_ID, "--location", "30.27,-97.74"],
  ];
  for (const argv of gone) {
    const { code } = await run(argv, { fetch: api.fetch, env });
    assert.equal(code, 2);
  }
  assert.equal(api.requests.length, 0);
});

test("update with only --lat and --lng moves the beacon, --anywhere clears it, and renew can carry a point", async () => {
  const api = fakeApi({
    "GET /v1/me/beacons": () => [200, { beacons: [ownBeacon()] }],
    [`PUT /v1/beacons/${BEACON_ID}`]: () => [200, { beacon: ownBeacon(), revision: 3, safety: "passed" }],
    [`POST /v1/beacons/${BEACON_ID}/renew`]: () => [200, { beacon: ownBeacon() }],
  });
  const moving = await run(["update", BEACON_ID, "--lat", "30.2672", "--lng", "-97.7431"], { fetch: api.fetch, env });
  assert.equal(moving.code, 0, moving.err);
  assert.deepEqual(api.requests.at(-1)?.body, { location: { lat: 30.2672, lng: -97.7431 }, revision: 3 });
  assert.match(moving.out, /Location kept\. Others read the exact point and when it was sent\./);
  assert.match(moving.out, /send it again in a few seconds, at most once every 3 seconds\./);
  const anywhere = await run(["update", BEACON_ID, "--anywhere"], { fetch: api.fetch, env });
  assert.equal(anywhere.code, 0, anywhere.err);
  assert.deepEqual(api.requests.at(-1)?.body, { location: null, revision: 3 });
  assert.match(anywhere.out, /It applies anywhere now\./);
  const both = await run(["update", BEACON_ID, "Free", "Friday", "--lng=-97.7431", "--lat", "30.2672"], { fetch: api.fetch, env });
  assert.deepEqual(api.requests.at(-1)?.body, { text: "Free Friday", location: { lat: 30.2672, lng: -97.7431 }, revision: 3 });
  assert.match(both.out, /Revision 3 shows once it passes its safety check/);
  const renewed = await run(["renew", BEACON_ID, "--lat", "30.27", "--lng", "-97.74"], { fetch: api.fetch, env });
  assert.equal(renewed.code, 0, renewed.err);
  assert.deepEqual(api.requests.at(-1)?.body, { location: { lat: 30.27, lng: -97.74 } });
  const sent = api.requests.length;
  for (const argv of [["renew", BEACON_ID, "--lat", "30.27"], ["update", BEACON_ID, "--anywhere", "--lat", "30", "--lng", "-97"]]) {
    const { code } = await run(argv, { fetch: api.fetch, env });
    assert.equal(code, 2);
  }
  assert.equal(api.requests.length, sent);
});

test("a location sent sooner than 3 seconds says how long to wait", async () => {
  const api = fakeApi({
    "GET /v1/me/beacons": () => [200, { beacons: [ownBeacon()] }],
    [`PUT /v1/beacons/${BEACON_ID}`]: () => [
      429,
      { status: 429, code: "rate_limited", detail: "This beacon’s location was updated less than 3 seconds ago.", next: "Send its location at most once every 3 seconds." },
      { "Retry-After": "2" },
    ],
  });
  const { code, err } = await run(["update", BEACON_ID, "--lat", "30.2672", "--lng", "-97.7431"], { fetch: api.fetch, env });
  assert.equal(code, 1);
  assert.match(err, /\(429 rate_limited\)/);
  assert.match(err, /Try again in 2 seconds\./);
});

test("beacons says where each is and when the point was sent, and search and show pass the Location line through", async () => {
  const updated = new Date(Date.now() - 8000).toISOString();
  const api = fakeApi({
    "GET /v1/me/beacons": () => [200, { beacons: [ownBeacon({ beacon: { location: { ...POINT, updated } } })] }],
    "GET /v1/beacons": () => [200, PAGE.replace("sent 4 minutes ago", "sent 8 seconds ago · 2.1 miles away, about 6 minutes")],
    [`GET /v1/beacons/${BEACON_ID}`]: () => [200, beaconMarkdown()],
  });
  const listed = await run(["beacons"], { fetch: api.fetch, env });
  assert.match(listed.out, /open until .* · revision 3\n  location 30\.2416, -97\.7695, sent \d+ seconds ago\n  76a21240/);
  const found = await run(["search", "ride", "to", "the", "airport", "--location", "78704"], { fetch: api.fetch });
  assert.match(found.out, /│ Location: 30\.2416, -97\.7695, sent 8 seconds ago · 2\.1 miles away, about 6\n│ minutes/);
  const shown = await run(["show", BEACON_ID], { fetch: api.fetch });
  assert.match(shown.out, /│ Location: 30\.2416, -97\.7695, sent 4 minutes ago/);
  assert.match(shown.out, /│ Verification \(agentbeacon\.sh\): Nothing about who made this was checked/);
});

test("delete asks first, refuses to guess without a terminal, and sends DELETE", async () => {
  const api = fakeApi({ [`DELETE /v1/beacons/${BEACON_ID}`]: () => [200, { deleted: true, erased_after: "2026-11-18T17:00:00Z" }] });
  const refused = await run(["delete", BEACON_ID], { fetch: api.fetch, env });
  assert.equal(refused.code, 2);
  assert.match(refused.err, /--yes/);
  assert.equal(api.requests.length, 0);
  const done = await run(["delete", BEACON_ID, "-y"], { fetch: api.fetch, env });
  assert.equal(done.code, 0, done.err);
  assert.equal(api.requests[0].method, "DELETE");
  assert.equal(api.requests[0].body, undefined);
  assert.match(done.out, /Deleted\./);
});

test("message, conversations, read, reply, mark and report use the conversation routes", async () => {
  const conversation = { id: CONVERSATION_ID, beacon_id: BEACON_ID, about: "my_beacons", outcome: null, unread: 1, messages: 2, closed: false, last_message_at: "2026-10-18T09:00:00Z", last_message: { from_me: false, text: "Can you come at 10?" } };
  const api = fakeApi({
    ...connected,
    [`POST /v1/beacons/${BEACON_ID}/messages`]: () => [201, { note: "…", conversation: { ...conversation, about: "sent" } }],
    "GET /v1/me/conversations": () => [200, { note: "Messages are written by others.", conversations: [conversation] }],
    [`GET /v1/conversations/${CONVERSATION_ID}`]: () => [200, { note: "Messages are written by others.", conversation, messages: [{ id: "m1", from_me: false, text: "Can you come at 10?", sent_at: "2026-10-18T09:00:00Z" }] }],
    [`POST /v1/conversations/${CONVERSATION_ID}/messages`]: () => [201, { message: { id: "m2" } }],
    [`PUT /v1/conversations/${CONVERSATION_ID}/outcome`]: () => [200, { conversation: { ...conversation, outcome: "booked" } }],
    [`POST /v1/conversations/${CONVERSATION_ID}/report`]: () => [202, { reported: true, blocked: false }],
  });
  const sent = await run(["message", BEACON_ID, "Can you come at 10?"], { fetch: api.fetch });
  assert.equal(sent.code, 0, sent.err);
  assert.deepEqual(api.requests[1].body, { text: "Can you come at 10?" });
  assert.match(sent.out, /Sent\. Nobody has read it yet/);
  assert.match(sent.out, new RegExp(`conversation ${CONVERSATION_ID}`));
  const listed = await run(["conversations", "--about", "my_beacons"], { fetch: api.fetch, env });
  assert.equal(api.requests.at(-1)?.url.searchParams.get("about"), "my_beacons");
  assert.match(listed.out, /● 1 unread · about your beacon/);
  assert.match(listed.out, /│ Can you come at 10\?/);
  const wrongKind = await run(["conversations", "--about", "holder"], { fetch: api.fetch, env });
  assert.equal(wrongKind.code, 2);
  const read = await run(["read", CONVERSATION_ID], { fetch: api.fetch, env });
  assert.match(read.out, /Them/);
  assert.match(read.out, /\bbeacon mark/);
  await run(["reply", CONVERSATION_ID, "Yes,", "10", "works."], { fetch: api.fetch, env });
  assert.deepEqual(api.requests.at(-1)?.body, { text: "Yes, 10 works." });
  const badMark = await run(["mark", CONVERSATION_ID, "won"], { fetch: api.fetch, env });
  assert.equal(badMark.code, 2);
  await run(["mark", CONVERSATION_ID, "booked"], { fetch: api.fetch, env });
  assert.deepEqual(api.requests.at(-1)?.body, { outcome: "booked" });
  await run(["report", CONVERSATION_ID, "no-show", "--keep-unblocked"], { fetch: api.fetch, env });
  assert.deepEqual(api.requests.at(-1)?.body, { reason: "no-show", block: false });
  await run(["report", CONVERSATION_ID, "spam"], { fetch: api.fetch, env });
  assert.deepEqual(api.requests.at(-1)?.body, { reason: "spam", block: true });
});

test("what the API says to do next is printed under the refusal", async () => {
  const next = "Tell the person, and offer others.";
  const api = fakeApi({
    [`POST /v1/beacons/${BEACON_ID}/messages`]: () => [410, { status: 410, code: "beacon_closed", detail: "This beacon expired: its creator didn’t renew it.", next }],
  });
  const { code, err } = await run(["message", BEACON_ID, "Is it still free?"], { fetch: api.fetch, env });
  assert.equal(code, 1);
  assert.match(err, /didn’t renew it\. \(410 beacon_closed\)\nTell the person, and offer others\./);
});

test("the API's refusal is shown with its code and when to retry", async () => {
  const api = fakeApi({
    [`POST /v1/conversations/${CONVERSATION_ID}/messages`]: () => [
      429,
      { title: "Too Many Requests", status: 429, detail: "The other side has had enough for today.", code: "rate_limited" },
      { "retry-after": "120" },
    ],
  });
  const { code, err } = await run(["reply", CONVERSATION_ID, "hello"], { fetch: api.fetch, env });
  assert.equal(code, 1);
  assert.match(err, /had enough for today\. \(429 rate_limited\)/);
  assert.match(err, /Try again in 120 seconds/);
});

test("messages on and off, and a takeover is started and confirmed with its code", async () => {
  const api = fakeApi({
    "PUT /v1/me/messages": ({ body }) => [200, { taking_messages: body.taking_messages }],
    [`POST /v1/beacons/${BEACON_ID}/takeover`]: ({ body }) =>
      body.method === "domain"
        ? [200, { takeover_id: CONVERSATION_ID, done: true, beacon: ownBeacon() }]
        : [202, { takeover_id: CONVERSATION_ID, done: false, next: "A code is on its way to the business's address." }],
    [`POST /v1/takeovers/${CONVERSATION_ID}/confirm`]: () => [200, { beacon: ownBeacon() }],
  });
  const off = await run(["messages", "off"], { fetch: api.fetch, env });
  assert.equal(off.code, 0, off.err);
  assert.deepEqual(api.requests[0].body, { taking_messages: false });
  assert.match(off.out, /Not taking new messages/);
  const wrong = await run(["messages", "close"], { fetch: api.fetch, env });
  assert.equal(wrong.code, 2);
  const started = await run(["takeover", BEACON_ID], { fetch: api.fetch, env });
  assert.deepEqual(api.requests[1].body, { method: "email" });
  assert.match(started.out, /code is on its way/);
  const byDomain = await run(["takeover", BEACON_ID, "--by-domain"], { fetch: api.fetch, env });
  assert.deepEqual(api.requests[2].body, { method: "domain" });
  assert.match(byDomain.out, /The beacon is yours\. Keep it open: beacon renew/);
  const noCode = await run(["confirm", CONVERSATION_ID], { fetch: api.fetch, env });
  assert.equal(noCode.code, 2);
  const confirmed = await run(["confirm", CONVERSATION_ID, "123456"], { fetch: api.fetch, env });
  assert.equal(confirmed.code, 0);
  assert.deepEqual(api.requests[3].body, { code: "123456" });
});

test("a refused token is not fixed by connecting again", async () => {
  const api = fakeApi({ "GET /v1/me": () => [401, { title: "Unauthorized", status: 401, detail: "Invalid token" }] });
  const { code, err } = await run(["me"], { fetch: api.fetch, env: { AGENTBEACON_TOKEN: "agt_bad" } });
  assert.equal(code, 1);
  assert.match(err, /AGENTBEACON_TOKEN/);
  assert.match(err, /separate account/);
});

test("connect and link send no body and take no --as, and me shows the agent and its account", async () => {
  const api = fakeApi({
    ...connected,
    "POST /v1/me/link": () => [201, { url: "https://agentbeacon.sh/link/abc", expires_at: "2026-10-18T10:00:00Z" }],
    "GET /v1/me": () => [200, { agent_id: "a1", linked_to_account: false }],
  });
  const first = await run(["connect"], { fetch: api.fetch });
  assert.equal(first.code, 0, first.err);
  assert.equal(api.requests[0].body, undefined);
  await run(["link"], { fetch: api.fetch, env });
  assert.equal(api.requests.at(-1)?.body, undefined);
  const me = await run(["me"], { fetch: api.fetch, env });
  assert.match(me.out, /Agent\s+a1/);
  assert.match(me.out, /not linked/);
  assert.doesNotMatch(me.out, /Acts for|Line/);
  for (const argv of [["connect", "--as", "business"], ["link", "--as", "person"]]) {
    const { code } = await run(argv, { fetch: api.fetch, env });
    assert.equal(code, 2);
  }
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
  const skill = '---\nname: agentbeacon\nmetadata:\n  version: "1.19.0"\n---\n# AgentBeacon\n';
  const site = fakeApi({ "GET /skill.md": () => [200, skill], "GET /heartbeat.md": () => [200, "# Heartbeat\n"] });
  const { home } = await run(["--version"]);
  await mkdir(join(home, ".claude"));
  await mkdir(join(home, ".cursor/skills/agentbeacon"), { recursive: true });
  await mkdir(join(home, ".codex"));
  await writeFile(join(home, ".cursor/skills/agentbeacon/SKILL.md"), "---\nname: someone-else\n---\n");

  const added = await run(["add"], { fetch: site.fetch, home });
  assert.equal(added.code, 0, added.err);
  assert.equal(await readFile(join(home, ".claude/skills/agentbeacon/SKILL.md"), "utf8"), skill);
  assert.equal(await readFile(join(home, ".codex/skills/agentbeacon/HEARTBEAT.md"), "utf8"), "# Heartbeat\n");
  assert.match(await readFile(join(home, ".cursor/skills/agentbeacon/SKILL.md"), "utf8"), /someone-else/);
  assert.match(added.err, /Skipped ~\/\.cursor\/skills\/agentbeacon/);

  const listed = await run(["add", "--list", "--json"], { home });
  const claude = JSON.parse(listed.out).agents.find((/** @type {any} */ a) => a.id === "claude-code");
  assert.equal(claude.skill, "1.19.0");

  const removed = await run(["remove", "-y"], { home });
  assert.equal(removed.code, 0, removed.err);
  await assert.rejects(stat(join(home, ".claude/skills/agentbeacon")));
  assert.match(await readFile(join(home, ".cursor/skills/agentbeacon/SKILL.md"), "utf8"), /someone-else/);
});

test("add refuses a download that is not the AgentBeacon skill", async () => {
  const site = fakeApi({ "GET /skill.md": () => [200, "<html>login</html>"], "GET /heartbeat.md": () => [200, ""] });
  const { code, err, home } = await run(["add", "-a", "claude-code"], { fetch: site.fetch });
  assert.equal(code, 1);
  assert.match(err, /not the AgentBeacon skill/);
  await assert.rejects(stat(join(home, ".claude/skills/agentbeacon")));
});

test("the old commands are gone, and usage mistakes exit with 2 and point at help", async () => {
  for (const old of ["find", "post", "listings", "send", "inbox", "end", "on", "off", "answer", "answers", "line"]) {
    const { code } = await run([old, "x"]);
    assert.equal(code, 2, old);
  }
  const unknown = await run(["serch", "x"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /Did you mean search\?/);
  const badFlag = await run(["search", "--category", "jobs", "x"]);
  assert.equal(badFlag.code, 2);
  assert.match(badFlag.err, /\bbeacon search --help/);
});
