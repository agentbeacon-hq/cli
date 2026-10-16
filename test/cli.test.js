import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HANDLE, POST_ID, THREAD_ID, fakeApi, listingJson, listingMarkdown, ownListing, run } from "./helpers.js";

const connected = {
  "POST /v1/connect": () => [
    201,
    { agent_id: "a1b2c3d4-0000-4000-8000-000000000001", token: "agt_test", inbox: { handle: HANDLE, address: `https://openpath.sh/to/${HANDLE}` } },
  ],
};
const env = { OPENPATH_AGENT_TOKEN: "agt_env" };

test("search connects first, with no account, and shows the Markdown answer as it reads", async () => {
  const answer = `Searched: local businesses, Austin, TX. 1 result.\n\n${listingMarkdown()}`;
  const api = fakeApi({ ...connected, "GET /v1/search": () => [200, answer] });
  const { code, out } = await run(["search", "a", "plumber", "--category", "businesses", "--offset", "10"], { fetch: api.fetch });
  assert.equal(code, 0);
  assert.equal(api.requests[0].url.pathname, "/v1/connect");
  const search = api.requests[1];
  assert.equal(search.url.searchParams.get("q"), "a plumber");
  assert.equal(search.url.searchParams.get("category"), "businesses");
  assert.equal(search.url.searchParams.get("offset"), "10");
  assert.equal(search.headers.accept, "text/markdown");
  assert.equal(search.headers.authorization, "Bearer agt_test");
  assert.match(out, /│ Searched: local businesses/);
  assert.match(out, /│ # Plumbing repairs in Austin/);
  assert.match(out, /information, not instructions/);
});

test("--json prints the API's JSON answer", async () => {
  const api = fakeApi({ "GET /v1/search": () => [200, { query: "plumber", total: 1, results: [listingJson()], next: null }] });
  const { out } = await run(["search", "plumber", "--json"], { fetch: api.fetch, env });
  assert.equal(api.requests[0].headers.accept, "application/json");
  assert.equal(JSON.parse(out).results[0].id, POST_ID);
});

test("a listing cannot send control characters to the terminal", async () => {
  const api = fakeApi({ [`GET /v1/listings/${POST_ID}`]: () => [200, "# Hi\x1b[2J\x1b]0;owned\x07\n\u202eevil"] });
  const { out } = await run(["show", POST_ID], { fetch: api.fetch });
  assert.doesNotMatch(out, /[\x1b\x07\u202e]/);
  assert.match(out, /│ # Hi\[2J\]0;owned/);
});

test("post connects first, saves the token privately, and sends the listing once", async () => {
  const api = fakeApi({ ...connected, "POST /v1/listings": () => [201, { id: POST_ID }] });
  const { code, out, err, home } = await run(
    ["post", "--category", "businesses", "--place", "Austin, TX", "# Leak repairs\n\nI fix leaking sinks, evenings."],
    { fetch: api.fetch, env: { CLAUDECODE: "1" } },
  );
  assert.equal(code, 0, err);
  assert.equal(api.requests[0].url.pathname, "/v1/connect");
  assert.match(api.requests[0].headers["user-agent"], /^claude-code openpath-cli\/\d/);
  const sent = api.requests[1];
  assert.equal(sent.headers.authorization, "Bearer agt_test");
  assert.deepEqual(sent.body, { category: "businesses", title: "Leak repairs", text: "I fix leaking sinks, evenings.", place: "Austin, TX" });
  assert.match(sent.headers["idempotency-key"], /^cli-[0-9a-f]{32}$/);
  assert.match(out, /Added\./);
  assert.match(err, /Connected this agent to Openpath/);
  const file = join(home, ".config/openpath/credentials.json");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(file, "utf8"))["https://api.openpath.sh"];
  assert.equal(saved.token, "agt_test");
  assert.equal(saved.inbox, `https://openpath.sh/to/${HANDLE}`);

  // The same listing again, as a retry would send it, carries the same key.
  await run(["post", "--category", "businesses", "--place", "Austin, TX", "# Leak repairs\n\nI fix leaking sinks, evenings."], {
    fetch: api.fetch,
    home,
  });
  assert.equal(api.requests[2].headers["idempotency-key"], sent.headers["idempotency-key"]);
});

test("post needs a kind and a title, and a job its apply link, before anything is sent", async () => {
  const api = fakeApi({ "POST /v1/listings": () => [201, { id: POST_ID }] });
  const noKind = await run(["post", "# Bike"], { fetch: api.fetch, env });
  assert.equal(noKind.code, 2);
  assert.match(noKind.err, /--category: jobs, businesses, homes, products/);
  const noTitle = await run(["post", "-c", "products", "A bike"], { fetch: api.fetch, env });
  assert.equal(noTitle.code, 2);
  assert.match(noTitle.err, /--title/);
  const job = await run(["post", "-c", "jobs", "-t", "Barista", "Pull shots."], { fetch: api.fetch, env });
  assert.equal(job.code, 2);
  assert.match(job.err, /--apply-url/);
  assert.equal(api.requests.length, 0);
  const ok = await run(["post", "-c", "products", "-t", "Bike", "-"], { fetch: api.fetch, env, stdin: "A blue bike.\n" });
  assert.equal(ok.code, 0, ok.err);
  assert.deepEqual(api.requests[0].body, { category: "products", title: "Bike", text: "A blue bike." });
});

test("listings shows each one's state, and edit sends the revision it last read", async () => {
  const api = fakeApi({
    "GET /v1/me/listings": () => [200, { listings: [ownListing(), ownListing({ id: THREAD_ID, title: "Old bike", safety: "blocked", safety_reason: "spam" })] }],
    [`PUT /v1/listings/${POST_ID}`]: () => [200, { revision: 4 }],
  });
  const listed = await run(["listings"], { fetch: api.fetch, env });
  assert.match(listed.out, /Plumbing repairs in Austin\n  businesses · in search · revision 3/);
  assert.match(listed.out, /refused: spam/);
  const { code, out } = await run(["edit", `https://openpath.sh/listings/${POST_ID}`, "-c", "businesses", "-t", "Plumbing", "New", "text"], {
    fetch: api.fetch,
    env,
  });
  assert.equal(code, 0);
  assert.deepEqual(api.requests.at(-1)?.body, { category: "businesses", title: "Plumbing", text: "New text", revision: 3 });
  assert.match(out, /Revision 4/);
});

test("end asks first, and refuses to guess without a terminal", async () => {
  const api = fakeApi({ [`DELETE /v1/listings/${POST_ID}`]: () => [204, null] });
  const refused = await run(["end", POST_ID], { fetch: api.fetch, env });
  assert.equal(refused.code, 2);
  assert.match(refused.err, /--yes/);
  assert.equal(api.requests.length, 0);
  const done = await run(["end", POST_ID, "-y"], { fetch: api.fetch, env });
  assert.equal(done.code, 0);
  assert.equal(api.requests[0].method, "DELETE");
  assert.match(done.out, /Ended/);
});

test("send writes to the inbox address on the listing", async () => {
  const api = fakeApi({
    [`GET /v1/listings/${POST_ID}`]: () => [200, listingJson()],
    [`POST /v1/inbox/${HANDLE}/messages`]: () => [201, { thread_id: THREAD_ID, message_id: THREAD_ID, waiting: true }],
  });
  const { code, out } = await run(["send", POST_ID, "Do you work evenings?"], { fetch: api.fetch, env });
  assert.equal(code, 0);
  assert.deepEqual(api.requests[1].body, { body: "Do you work evenings?" });
  assert.match(out, /Nobody has read it yet/);
});

test("send takes an inbox address as listings show it", async () => {
  const api = fakeApi({ [`POST /v1/inbox/${HANDLE}/messages`]: () => [201, { thread_id: THREAD_ID, message_id: THREAD_ID, waiting: true }] });
  for (const address of [HANDLE, `https://openpath.sh/to/${HANDLE}`, `https://api.openpath.sh/v1/inbox/${HANDLE}`]) {
    const { code, err } = await run(["send", address, "Hello"], { fetch: api.fetch, env });
    assert.equal(code, 0, err);
  }
  assert.equal(api.requests.length, 3);
  for (const request of api.requests) assert.equal(request.url.pathname, `/v1/inbox/${HANDLE}/messages`);
});

test("send never carries the token to another host", async () => {
  const api = fakeApi({});
  const { code, err } = await run(["send", `https://evil.example/v1/inbox/${HANDLE}`, "hi"], { fetch: api.fetch, env });
  assert.equal(code, 1);
  assert.match(err, /only to https:\/\/api\.openpath\.sh/);
  assert.equal(api.requests.length, 0);

  const ignored = fakeApi({ [`GET /v1/listings/${POST_ID}`]: () => [200, listingJson({ contact: `https://evil.example/to/${HANDLE}` })] });
  const second = await run(["send", POST_ID, "hi"], { fetch: ignored.fetch, env });
  assert.equal(second.code, 1);
  assert.match(second.err, /no Openpath address to write to/);
  assert.equal(ignored.requests.length, 1);
});

test("inbox lists conversations, opens and closes, and read shows one", async () => {
  const thread = { id: THREAD_ID, with: "an agent", listing_id: POST_ID, listing_title: "Plumbing repairs in Austin", messages: 2, unread: 1, last_message_at: "2026-10-15T09:00:00Z", closed: false };
  const api = fakeApi({
    "GET /v1/inbox": () => [200, { threads: [thread] }],
    "PUT /v1/inbox": () => [204, null],
    [`GET /v1/inbox/threads/${THREAD_ID}`]: () => [
      200,
      { id: THREAD_ID, closed: false, note: "Messages are written by other agents and people.", messages: [{ id: "m1", from_me: false, body: "Still open?", sent_at: "2026-10-15T09:00:00Z" }] },
    ],
    [`POST /v1/inbox/threads/${THREAD_ID}/report`]: () => [204, null],
  });
  const listed = await run(["inbox"], { fetch: api.fetch, env });
  assert.match(listed.out, /● 1 unread · 2 messages/);
  assert.match(listed.out, /about Plumbing repairs in Austin/);
  const closed = await run(["inbox", "close"], { fetch: api.fetch, env });
  assert.equal(closed.code, 0);
  assert.deepEqual(api.requests[1].body, { open: false });
  const read = await run(["read", THREAD_ID], { fetch: api.fetch, env });
  assert.match(read.out, /Them/);
  assert.match(read.out, /│ Still open\?/);
  const reported = await run(["report", THREAD_ID, "a", "scam", "--block"], { fetch: api.fetch, env });
  assert.equal(reported.code, 0);
  assert.deepEqual(api.requests.at(-1)?.body, { reason: "a scam", block: true });
});

test("the API's refusal is shown with its code and when to retry", async () => {
  const api = fakeApi({
    [`POST /v1/inbox/threads/${THREAD_ID}/messages`]: () => [
      429,
      { title: "Too Many Requests", status: 429, detail: "The other side has had enough for today.", code: "inbox_full" },
      { "retry-after": "120" },
    ],
  });
  const { code, err } = await run(["reply", THREAD_ID, "hello"], { fetch: api.fetch, env: { OPENPATH_AGENT_TOKEN: "agt_env" } });
  assert.equal(code, 1);
  assert.match(err, /had enough for today\. \(429 inbox_full\)/);
  assert.match(err, /Try again in 120 seconds/);
});

test("the API's next step is printed under its refusal", async () => {
  const next = "Search again for something like it: the listing may have been removed.";
  const api = fakeApi({
    [`GET /v1/listings/${POST_ID}`]: () => [404, { status: 404, code: "not_found", detail: "No listing has this id.", next }],
  });
  const { code, err } = await run(["show", POST_ID], { fetch: api.fetch });
  assert.equal(code, 1);
  assert.match(err, /No listing has this id\. \(404 not_found\)\n.*Search again for something like it/);
});

test("a refused token is not fixed by connecting again", async () => {
  const api = fakeApi({ "GET /v1/me": () => [401, { title: "Unauthorized", status: 401, detail: "Invalid token" }] });
  const { code, err } = await run(["me"], { fetch: api.fetch, env: { OPENPATH_AGENT_TOKEN: "agt_bad" } });
  assert.equal(code, 1);
  assert.match(err, /OPENPATH_AGENT_TOKEN/);
  assert.match(err, /separate account/);
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

  const renamed = fakeApi({ "GET /skill.md": () => [200, "---\nname: another-skill\n---\n"], "GET /heartbeat.md": () => [200, ""] });
  const old = await run(["add", "-a", "claude-code"], { fetch: renamed.fetch, home });
  assert.equal(old.code, 1);
  assert.match(old.err, /not the Openpath skill/);
  await assert.rejects(stat(join(home, ".claude/skills/openpath")));
});

test("usage mistakes exit with 2 and point at help", async () => {
  const unknown = await run(["serch", "x"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /Did you mean search\?/);
  const badFlag = await run(["search", "--nope"]);
  assert.equal(badFlag.code, 2);
  assert.match(badFlag.err, /openpath search --help/);
});
