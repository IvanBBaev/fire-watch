/**
 * Whether the reader has already granted geolocation to this site.
 *
 * The event page shows the distance to a fire only when that costs the reader nothing: a
 * page that opens a permission prompt on its own trains people to dismiss it, and a
 * permalink opened from a chat should never ask where the reader is. So the page locates
 * silently only on `granted`; every other state waits for a press on the button.
 *
 * Never rejects: a browser without the Permissions API, or one that does not know the
 * `geolocation` name, simply answers "not granted".
 */

interface PermissionsLike {
  query(descriptor: { name: 'geolocation' }): Promise<{ readonly state: string }>;
}

export async function geolocationAlreadyGranted(
  permissions: PermissionsLike | undefined = globalThis.navigator?.permissions,
): Promise<boolean> {
  if (permissions === undefined) return false;
  try {
    const status = await permissions.query({ name: 'geolocation' });
    return status.state === 'granted';
  } catch {
    return false;
  }
}
