/**
 * The URL fragment as a set of `&`-separated `key=value` members — `#map=7/42.7/25.3&t=6h`.
 *
 * Several owners share the fragment (the camera's `map=`, the filters' `t=`/`src=`/`r=`,
 * the sign-in link's `token=`), and each writes only its own members. Everything here
 * therefore *preserves* members it was not asked to change, in their original order, so
 * one writer can never erase another's state — and a link written by an older or newer
 * build keeps whatever this build does not understand.
 */

function membersOf(hash: string): string[] {
  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  return fragment === '' ? [] : fragment.split('&').filter((member) => member !== '');
}

/** The value of `key=` (first occurrence), or `null` when the member is absent. */
export function readFragmentMember(hash: string, key: string): string | null {
  const prefix = `${key}=`;
  const member = membersOf(hash).find((m) => m.startsWith(prefix));
  return member === undefined ? null : member.slice(prefix.length);
}

/**
 * The fragment with `updates` applied: a string sets the member (in place when present,
 * appended otherwise), `null` removes it. Returns `''` when nothing is left, so the caller
 * can drop a bare `#`; otherwise the result starts with `#`.
 */
export function withFragmentMembers(
  hash: string,
  updates: Readonly<Record<string, string | null>>,
): string {
  const members = membersOf(hash);
  const out: string[] = [];
  const written = new Set<string>();
  for (const member of members) {
    const eq = member.indexOf('=');
    const key = eq < 0 ? member : member.slice(0, eq);
    if (!Object.hasOwn(updates, key)) {
      out.push(member);
      continue;
    }
    if (written.has(key)) continue; // duplicates of an owned member collapse to one
    written.add(key);
    const value = updates[key];
    if (value !== null && value !== undefined) out.push(`${key}=${value}`);
  }
  for (const [key, value] of Object.entries(updates)) {
    if (!written.has(key) && value !== null) out.push(`${key}=${value}`);
  }
  return out.length === 0 ? '' : `#${out.join('&')}`;
}

/**
 * The fragment with every member of `members` that `hash` *lacks* filled in, and nothing
 * else touched: a member already present keeps its value, a `null` in `members` adds
 * nothing. This is the repair a route change needs. An in-app navigation pushes a URL
 * built from a link's `href`, which carries no fragment at all, so the camera, filters
 * and overlays the reader was looking at vanish from the address bar although the page
 * still shows them. Filling only what is missing — never overwriting — keeps a Back step
 * honest: the entry it returns to carries the members it was left with, and those win.
 */
export function withMissingFragmentMembers(
  hash: string,
  members: Readonly<Record<string, string | null>>,
): string {
  const missing: Record<string, string> = {};
  for (const [key, value] of Object.entries(members)) {
    if (value !== null && readFragmentMember(hash, key) === null) missing[key] = value;
  }
  return withFragmentMembers(hash, missing);
}
