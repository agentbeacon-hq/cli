import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { main } from "../src/main.js";

export const POST_ID = "76a21240-f7e2-40f3-b45c-1a28aa6dc4b2";
export const THREAD_ID = "0b6d1c1e-7a52-4c55-9f0e-3b1a2c4d5e6f";
export const HANDLE = "4k7m9qxr2ht3";

/** An owner's own listing as GET /v1/listings/{id} answers in JSON. @param {Partial<Record<string, any>>} [overrides] */
export function post(overrides = {}) {
  const content = overrides.content ?? "# Plumbing repairs\n\nI fix leaking sinks.";
  return {
    id: POST_ID,
    kind: "listing",
    url: `https://api.openpath.sh/v1/listings/${POST_ID}`,
    markdown: `${content}\n\nContact: https://openpath.sh/to/${HANDLE}\nPosted by the owner, updated today.`,
    content,
    images: [],
    revision: 3,
    updated_at: "2026-09-20T09:00:00Z",
    archived_at: null,
    archived: false,
    integrity: { proofs: ["google_account", "phone_number"], domains: [], since: "2026-03", posts: 1 },
    ...overrides,
  };
}

/** A search answer in JSON, with these listings as results. @param {any[]} listings */
export function found(listings) {
  return {
    query: "a plumber",
    searched: "everything, anywhere in the US",
    total: listings.length,
    results: listings.map((listing) => ({ id: listing.id, kind: "listing", url: listing.url, markdown: listing.markdown })),
    next: null,
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
