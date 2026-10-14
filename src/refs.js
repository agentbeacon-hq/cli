// Turning what people paste (links, addresses, ids) into what the API takes.


const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HANDLE = "[0-9abcdefghjkmnpqrstvwxyz]{12}";

/** A listing or thread id, from the id itself or any link that contains it. */
export function uuidIn(/** @type {string} */ value) {
  return value.match(UUID)?.[0].toLowerCase() ?? null;
}

/** Whether `value` names an Openpath inbox rather than a listing. */
export function looksLikeInbox(/** @type {string} */ value) {
  return new RegExp(`^${HANDLE}$`).test(value) || new RegExp(`/(?:v1/inbox|to)/${HANDLE}/?$`).test(value);
}

/**
 * The handle in an inbox address: `{site}/to/{handle}` as listings show it,
 * or `{api}/v1/inbox/{handle}`. Accepted only on the site and the API this
 * CLI talks to, because the request that follows carries the agent token.
 * @param {string} value
 * @param {string} api
 * @param {string | null} [web]
 */
export function inboxHandle(value, api, web = null) {
  if (new RegExp(`^${HANDLE}$`).test(value)) return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  for (const [base, path] of [
    [api, "v1/inbox"],
    [web, "to"],
  ]) {
    if (!base) continue;
    const root = new URL(base);
    const prefix = root.pathname.replace(/\/+$/, "");
    const match = url.pathname.match(new RegExp(`^${prefix}/${path}/(${HANDLE})/?$`));
    if (!match) continue;
    if (url.origin !== root.origin) continue;
    return match[1];
  }
  if (looksLikeInbox(value)) {
    throw new Error(
      `${url.origin} is not Openpath. The CLI sends this agent's token only to ${new URL(api).origin}.`,
    );
  }
  return null;
}

/**
 * The inbox a listing reaches its owner at, from the Contact line it reads
 * with, as an address on this site or API. Openpath writes that line in the
 * listing's closing lines, after its text, so the last one is Openpath's: a
 * line in the text that only looks like it is never the one used.
 * @param {string} markdown
 * @param {string} api
 * @param {string | null} [web]
 */
export function contactIn(markdown, api, web = null) {
  const line = [...markdown.matchAll(/^Contact: (\S+)\s*$/gm)].at(-1)?.[1];
  if (!line) return null;
  try {
    return inboxHandle(line, api, web);
  } catch {
    // An address on another host is not one this CLI will write to.
    return null;
  }
}
