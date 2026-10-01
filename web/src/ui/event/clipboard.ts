/**
 * Copy text for a button that reports the outcome. Resolves `false` rather than throwing
 * when the Clipboard API is missing or refused (insecure context, permissions), so the
 * page can tell the reader to copy the visible text by hand.
 */
export async function copyText(
  text: string,
  clipboard: Pick<Clipboard, 'writeText'> | undefined = globalThis.navigator?.clipboard,
): Promise<boolean> {
  if (clipboard === undefined) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
