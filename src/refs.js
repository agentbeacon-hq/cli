// Turning what people paste (links, ids) into what the API takes.

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** A beacon, answer or takeover id, from the id itself or any link that contains it. */
export function uuidIn(/** @type {string} */ value) {
  return value.match(UUID)?.[0].toLowerCase() ?? null;
}
