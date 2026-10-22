import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { main } from "../src/main.js";

export const BEACON_ID = "76a21240-f7e2-40f3-b45c-1a28aa6dc4b2";
export const CONVERSATION_ID = "0b6d1c1e-7a52-4c55-9f0e-3b1a2c4d5e6f";

/** A beacon as GET /v1/beacons/{id} answers it in Markdown. */
export function beaconMarkdown() {
  return `## Free tomorrow 9–12 for leaks and clogs\n> Free tomorrow 9–12 for leaks and clogs, near 78704, from $95.\nRenewed 4 minutes ago · Until Oct 19, 12:00 CDT · Austin, TX 78704\nMessage: POST https://api.openpath.sh/v1/beacons/${BEACON_ID}/messages\nKept up to date by the business.\nLink: https://openpath.sh/beacon/${BEACON_ID}\n`;
}

/** One of this agent's own beacons (a MyBeacon), as GET /v1/me/beacons lists it. @param {Partial<Record<string, any>>} [overrides] */
export function ownBeacon(overrides = {}) {
  return {
    id: BEACON_ID,
    closed: false,
    until: "2026-10-19T17:00:00Z",
    renew_from: "2026-10-19T16:45:00Z",
    deletes_at: null,
    updated_at: "2026-10-19T16:00:00Z",
    shown_revision: 3,
    text: "Free tomorrow 9–12 for leaks and clogs, near 78704, from $95.",
    place: { name: "Austin, TX 78704", remote: false },
    latest_revision: 3,
    latest_text: "Free tomorrow 9–12 for leaks and clogs, near 78704, from $95.",
    latest_safety: "passed",
    latest_safety_reason: null,
    conversations_waiting: 0,
    live_updated_at: null,
    link: `https://openpath.sh/beacon/${BEACON_ID}`,
    ...overrides,
  };
}

/**
 * A fake API. Each route answers `METHOD /path` with a status and body, and
 * every request is kept so a test can check what was sent.
 * @param {Record<string, (request: { body: any, headers: Record<string, string>, url: URL }) => [number, unknown, Record<string, string>?]>} routes
 */
export function fakeApi(routes) {
  /** @type {{ method: string, url: URL, headers: Record<string, string>, body: any }[]} */
  const requests = [];
  /** @type {typeof fetch} */
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    let body = init.body;
    if (typeof body === "string" && headers["content-type"] === "application/json") body = JSON.parse(body);
    requests.push({ method, url, headers, body });
    const route = routes[`${method} ${url.pathname}`];
    if (!route) return new Response(JSON.stringify({ title: "Not Found", status: 404, detail: "No route" }), { status: 404 });
    const [status, payload, extra] = route({ body, headers, url });
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    return new Response(status === 204 ? null : text, { status, headers: extra });
  };
  return { fetch, requests };
}

/**
 * Run the CLI with captured output and a throwaway home folder.
 * @param {string[]} argv
 * @param {{ fetch?: typeof fetch, env?: Record<string, string>, home?: string, stdin?: string, cwd?: string }} [options]
 */
export async function run(argv, options = {}) {
  const home = options.home ?? (await mkdtemp(join(tmpdir(), "openpath-cli-")));
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "";
  let err = "";
  stdout.on("data", (chunk) => (out += chunk));
  stderr.on("data", (chunk) => (err += chunk));
  const stdin = Object.assign(Readable.from(options.stdin === undefined ? [] : [options.stdin]), { isTTY: false });
  const code = await main(argv, {
    env: { OPENPATH_CONFIG_DIR: join(home, ".config/openpath"), ...options.env },
    home,
    cwd: options.cwd ?? home,
    fetch: options.fetch ?? (async () => new Response("{}", { status: 500 })),
    stdin,
    stdout: Object.assign(stdout, { isTTY: false, columns: 80 }),
    stderr: Object.assign(stderr, { isTTY: false }),
  });
  return { code, out, err, home };
}
