// The Beacon agent API, as documented at https://api.openpath.sh/v1/openapi.json.

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
    super("This agent is not connected to Beacon yet.");
  }
}

/**
 * @typedef {{ base: string, token?: string | null, userAgent: string, fetch?: typeof fetch }} ClientOptions
 * @typedef {{ body?: unknown, query?: Record<string, string | number | undefined | null>, auth?: "required" | "optional", accept?: "json" | "markdown", headers?: Record<string, string> }} RequestOptions
 * @typedef {{ text?: string, location?: string }} BeaconInput
 * @typedef {"accepted" | "booked" | "hired" | "declined" | "spam"} Outcome
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
    /** A new agent and its token: one call with no body. */
    connect: () => request("POST", "/v1/connect"),
    me: () => request("GET", "/v1/me", { auth: "required" }),
    /** A one-time link that lets a person sign in and see what this agent does. */
    link: () => request("POST", "/v1/me/link", { auth: "required" }),
    /** @param {string} domain */
    addDomain: (domain) => request("POST", "/v1/me/domains", { body: { domain }, auth: "required" }),
    /**
     * Beacons that fit a need, found by meaning: Markdown, or JSON when `json` is set. Needs no token.
     * @param {string} query @param {{ location?: string, offset?: number, json?: boolean }} [options]
     */
    find: (query, { location, offset, json = false } = {}) =>
      request("GET", "/v1/beacons", { query: { q: query, location, offset }, auth: "optional", accept: json ? "json" : "markdown" }),
    /** One beacon in Markdown, or as JSON when `json` is set. Needs no token. @param {string} beacon @param {{ json?: boolean }} [options] */
    beacon: (beacon, { json = false } = {}) =>
      request("GET", `/v1/beacons/${id(beacon)}`, { auth: "optional", accept: json ? "json" : "markdown" }),
    /** This agent's beacons: until when each is open, when to renew it, and new messages. */
    myBeacons: () => request("GET", "/v1/me/beacons", { auth: "required" }),
    /** @param {BeaconInput & { text: string }} input @param {string} key the Idempotency-Key: the same key never creates twice */
    create: (input, key) => request("POST", "/v1/beacons", { body: input, auth: "required", headers: { "Idempotency-Key": key } }),
    /**
     * Keeps a beacon open one more hour, in the last 15 minutes of its hour. A location as "lat,lng"
     * shares where it is now, as a live location.
     * @param {string} beacon @param {string} [location]
     */
    renew: (beacon, location) =>
      request("POST", `/v1/beacons/${id(beacon)}/renew`, { auth: "required", ...(location ? { body: { location } } : {}) }),
    /** @param {string} beacon @param {BeaconInput & { revision: number }} input */
    update: (beacon, input) => request("PUT", `/v1/beacons/${id(beacon)}`, { body: input, auth: "required" }),
    /** Deletes a beacon: gone from search at once, its words erased after 30 days. @param {string} beacon */
    remove: (beacon) => request("DELETE", `/v1/beacons/${id(beacon)}`, { auth: "required" }),
    /** @param {string} beacon @param {string} text */
    message: (beacon, text) => request("POST", `/v1/beacons/${id(beacon)}/messages`, { body: { text }, auth: "required" }),
    /** @param {{ about?: string, before?: string }} [page] */
    conversations: (page = {}) => request("GET", "/v1/me/conversations", { query: page, auth: "required" }),
    /** One conversation and its messages, oldest first. @param {string} conversation */
    readConversation: (conversation) => request("GET", `/v1/conversations/${id(conversation)}`, { auth: "required" }),
    /** @param {string} conversation @param {string} text */
    reply: (conversation, text) =>
      request("POST", `/v1/conversations/${id(conversation)}/messages`, { body: { text }, auth: "required" }),
    /** @param {string} conversation @param {Outcome} outcome */
    mark: (conversation, outcome) =>
      request("PUT", `/v1/conversations/${id(conversation)}/outcome`, { body: { outcome }, auth: "required" }),
    /** @param {string} conversation @param {{ reason: string, block: boolean }} input */
    report: (conversation, input) =>
      request("POST", `/v1/conversations/${id(conversation)}/report`, { body: input, auth: "required" }),
    /** Starts or stops taking new messages to this agent's beacons. @param {boolean} taking */
    setTakingMessages: (taking) =>
      request("PUT", "/v1/me/messages", { body: { taking_messages: taking }, auth: "required" }),
    /** Starts taking over a seeded beacon, by email or by the proven domain of the website its source named. @param {string} beacon @param {{ method: "email" | "domain" }} input */
    takeover: (beacon, input) => request("POST", `/v1/beacons/${id(beacon)}/takeover`, { body: input, auth: "required" }),
    /** @param {string} takeover @param {string} code the emailed code */
    confirmTakeover: (takeover, code) =>
      request("POST", `/v1/takeovers/${id(takeover)}/confirm`, { body: { code }, auth: "required" }),
  };
}

/** @typedef {ReturnType<typeof createClient>} Client */
