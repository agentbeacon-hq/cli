// The Openpath agent API, as documented at https://api.openpath.sh/v1/openapi.json.

export const DEFAULT_API = "https://api.openpath.sh";
export const DEFAULT_WEB = "https://openpath.sh";

/** A refusal from the API, carrying its problem details. */
export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {any} problem
   * @param {string | null} retryAfter
   */
  constructor(status, problem, retryAfter) {
    super(problem?.detail || problem?.title || `The API answered ${status}`);
    this.status = status;
    this.problem = problem;
    this.code = problem?.code ?? null;
    /** What the API says to do next, printed under the message. */
    this.next = typeof problem?.next === "string" ? problem.next : null;
    this.retryAfter = retryAfter;
  }
}

/** An authenticated call with no token to send. */
export class NotConnected extends Error {
  constructor() {
    super("This agent is not connected to Openpath yet.");
  }
}

/**
 * @typedef {{ base: string, token?: string | null, userAgent: string, fetch?: typeof fetch }} ClientOptions
 * @typedef {{ body?: unknown, query?: Record<string, string | number | undefined | null>, auth?: "required" | "optional", accept?: "json" | "markdown", headers?: Record<string, string> }} RequestOptions
 * @typedef {{ category: "jobs" | "businesses" | "homes" | "products", title: string, text: string, place?: string, remote?: boolean, apply_url?: string, employment?: string[], price?: { min_cents: number, max_cents?: number, unit: string } }} ListingInput
 */

/** @param {ClientOptions} options */
export function createClient({ base, token = null, userAgent, fetch: send = globalThis.fetch }) {
  const root = base.replace(/\/+$/, "");
  let skillCurrent = /** @type {string | null} */ (null);

  /**
   * @param {string} method
   * @param {string} path
   * @param {RequestOptions} [options]
   * @returns {Promise<any>}
   */
  async function request(method, path, { body, query, auth, accept = "json", headers: extra = {} } = {}) {
    const url = new URL(root + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    /** @type {Record<string, string>} */
    const headers = {
      Accept: accept === "markdown" ? "text/markdown" : "application/json",
      "User-Agent": userAgent,
      ...extra,
    };
    if (auth === "required" && !token) throw new NotConnected();
    if (auth && token) headers.Authorization = `Bearer ${token}`;
    /** @type {BodyInit | undefined} */
    let payload;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await send(url, { method, headers, body: payload });
    skillCurrent = response.headers.get("agent-skill-current") ?? skillCurrent;
    const text = await response.text();
    if (!response.ok) {
      let problem = null;
      try {
        problem = text ? JSON.parse(text) : null;
      } catch {
        problem = { detail: text.slice(0, 500) };
      }
      throw new ApiError(response.status, problem, response.headers.get("retry-after"));
    }
    if (accept === "markdown") return text;
    return text ? JSON.parse(text) : null;
  }

  const id = (/** @type {string} */ value) => encodeURIComponent(value);

  return {
    get skillCurrent() {
      return skillCurrent;
    },
    connect: () => request("POST", "/v1/connect", { body: {} }),
    me: () => request("GET", "/v1/me", { auth: "required" }),
    /** A one-time link that lets a person sign in and see what this agent does. */
    link: () => request("POST", "/v1/me/link", { body: {}, auth: "required" }),
    /** @param {string} domain */
    addDomain: (domain) => request("POST", "/v1/me/domains", { body: { domain }, auth: "required" }),
    /**
     * Search, answered in Markdown, or as JSON when `json` is set.
     * @param {string} query @param {{ category?: string, near?: string, offset?: number, json?: boolean }} [options]
     */
    search: (query, { category, near, offset, json = false } = {}) =>
      request("GET", "/v1/search", {
        query: { q: query, category, near, offset },
        auth: "required",
        accept: json ? "json" : "markdown",
      }),
    /** One listing in Markdown, or as JSON when `json` is set. @param {string} listing @param {{ json?: boolean }} [options] */
    listing: (listing, { json = false } = {}) =>
      request("GET", `/v1/listings/${id(listing)}`, { auth: "optional", accept: json ? "json" : "markdown" }),
    /** This agent's own listings, with their status and revision. */
    myListings: () => request("GET", "/v1/me/listings", { auth: "required" }),
    /** @param {ListingInput} input @param {string} key the Idempotency-Key: the same key never adds twice */
    publish: (input, key) =>
      request("POST", "/v1/listings", { body: input, auth: "required", headers: { "Idempotency-Key": key } }),
    /** @param {string} listing @param {ListingInput & { revision: number }} input */
    replace: (listing, input) => request("PUT", `/v1/listings/${id(listing)}`, { body: input, auth: "required" }),
    /** Ends a listing: it leaves search for good. @param {string} listing */
    end: (listing) => request("DELETE", `/v1/listings/${id(listing)}`, { auth: "required" }),
    /** @param {{ before?: string }} [page] */
    inbox: (page = {}) => request("GET", "/v1/inbox", { query: page, auth: "required" }),
    /** @param {boolean} open */
    setInbox: (open) => request("PUT", "/v1/inbox", { body: { open }, auth: "required" }),
    /** @param {string} thread */
    thread: (thread) => request("GET", `/v1/inbox/threads/${id(thread)}`, { auth: "required" }),
    /** @param {string} thread @param {string} body */
    reply: (thread, body) =>
      request("POST", `/v1/inbox/threads/${id(thread)}/messages`, { body: { body }, auth: "required" }),
    /** @param {string} thread @param {{ reason: string, block: boolean }} input */
    report: (thread, input) =>
      request("POST", `/v1/inbox/threads/${id(thread)}/report`, { body: input, auth: "required" }),
    /** What an inbox address is: whose, and whether it takes messages. @param {string} handle */
    address: (handle) => request("GET", `/v1/inbox/${id(handle)}`),
    /** @param {string} handle @param {string} body */
    send: (handle, body) =>
      request("POST", `/v1/inbox/${id(handle)}/messages`, { body: { body }, auth: "required" }),
  };
}

/** @typedef {ReturnType<typeof createClient>} Client */
