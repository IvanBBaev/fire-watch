/**
 * A minimal, pure XML reader for the two MeteoAlarm shapes V2-B3 consumes: the legacy Atom
 * feed and a CAP 1.2 alert (DATA-SOURCES-EXTENDED §J11).
 *
 * Deliberately small rather than general, and deliberately without a dependency:
 *
 *   * **No DTD, no entity expansion.** A `<!DOCTYPE` is refused outright, so no document
 *     can define entities, reach the filesystem or grow without bound. Only the five
 *     predefined entities and numeric character references are decoded.
 *   * **Names are kept as written.** `cap:geocode` stays `cap:geocode`; namespaces are not
 *     resolved. Both feeds bind their prefixes the same way every time, and the reader
 *     asks for the qualified names it expects.
 *   * **Comments, processing instructions and the XML declaration are skipped**; CDATA is
 *     text.
 *   * **Anything malformed is `null`**, never a partial tree: an unclosed or mismatched
 *     tag, an attribute without quotes, a second root.
 */

export interface XmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
}

export type XmlNode = XmlElement | string;

interface OpenElement {
  readonly name: string;
  readonly attributes: Record<string, string>;
  readonly children: XmlNode[];
}

const NAME = /^[A-Za-z_][\w.:-]*/;
const ATTRIBUTE = /^\s+([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/;

/** Parses one document into its root element, or `null` when it is not well-formed. */
export function parseXml(text: string): XmlElement | null {
  const stack: OpenElement[] = [];
  let root: XmlElement | null = null;
  let index = 0;

  const appendText = (raw: string): boolean => {
    const top = stack.at(-1);
    if (top === undefined) return raw.trim() === '';
    const decoded = decodeEntities(raw);
    if (decoded === null) return false;
    top.children.push(decoded);
    return true;
  };

  while (index < text.length) {
    const lt = text.indexOf('<', index);
    if (lt === -1) {
      if (!appendText(text.slice(index))) return null;
      break;
    }
    if (lt > index && !appendText(text.slice(index, lt))) return null;

    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end === -1) return null;
      index = end + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      const top = stack.at(-1);
      if (end === -1 || top === undefined) return null;
      top.children.push(text.slice(lt + 9, end));
      index = end + 3;
    } else if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end === -1) return null;
      index = end + 2;
    } else if (text.startsWith('<!', lt)) {
      // DOCTYPE and every other declaration: refused, see the module note.
      return null;
    } else if (text.startsWith('</', lt)) {
      const end = text.indexOf('>', lt + 2);
      if (end === -1) return null;
      const name = text.slice(lt + 2, end).trim();
      const open = stack.pop();
      if (open === undefined || open.name !== name) return null;
      const closed: XmlElement = open;
      const parent = stack.at(-1);
      if (parent === undefined) {
        if (root !== null) return null;
        root = closed;
      } else {
        parent.children.push(closed);
      }
      index = end + 1;
    } else {
      const parsed = readStartTag(text, lt + 1);
      if (parsed === null) return null;
      const element: OpenElement = {
        name: parsed.name,
        attributes: parsed.attributes,
        children: [],
      };
      index = parsed.next;
      if (parsed.selfClosing) {
        const parent = stack.at(-1);
        if (parent === undefined) {
          if (root !== null) return null;
          root = element;
        } else {
          parent.children.push(element);
        }
      } else {
        if (stack.length === 0 && root !== null) return null;
        stack.push(element);
      }
    }
  }
  return stack.length === 0 ? root : null;
}

function readStartTag(
  text: string,
  from: number,
): {
  name: string;
  attributes: Record<string, string>;
  selfClosing: boolean;
  next: number;
} | null {
  const nameMatch = NAME.exec(text.slice(from, from + 256));
  if (nameMatch === null) return null;
  const name = nameMatch[0];
  let cursor = from + name.length;
  const attributes: Record<string, string> = {};
  for (;;) {
    const rest = text.slice(cursor, cursor + 4096);
    const closing = /^\s*(\/?)>/.exec(rest);
    if (closing !== null) {
      return {
        name,
        attributes,
        selfClosing: closing[1] === '/',
        next: cursor + closing[0].length,
      };
    }
    const attribute = ATTRIBUTE.exec(rest);
    if (attribute === null) return null;
    const attributeName = attribute[1] ?? '';
    const value = decodeEntities(attribute[3] ?? attribute[4] ?? '');
    if (value === null || Object.hasOwn(attributes, attributeName)) return null;
    attributes[attributeName] = value;
    cursor += attribute[0].length;
  }
}

const PREDEFINED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** Decodes the predefined entities and numeric references; any other `&` is malformed. */
export function decodeEntities(raw: string): string | null {
  if (!raw.includes('&')) return raw;
  let failed = false;
  const decoded = raw.replace(/&([^;\s&]{0,10});?/g, (match, body: string) => {
    if (!match.endsWith(';')) {
      failed = true;
      return match;
    }
    const named = PREDEFINED[body];
    if (named !== undefined) return named;
    const numeric = /^#(x[0-9A-Fa-f]{1,6}|[0-9]{1,7})$/.exec(body);
    if (numeric !== null) {
      const digits = numeric[1] ?? '';
      const code = digits.startsWith('x')
        ? Number.parseInt(digits.slice(1), 16)
        : Number.parseInt(digits, 10);
      if (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
        return String.fromCodePoint(code);
      }
    }
    failed = true;
    return match;
  });
  return failed ? null : decoded;
}

/** The direct children of `element` called `name`. */
export function childElements(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter(
    (child): child is XmlElement => typeof child !== 'string' && child.name === name,
  );
}

/** The first direct child of `element` called `name`. */
export function firstChild(element: XmlElement, name: string): XmlElement | undefined {
  return childElements(element, name)[0];
}

/** All text below `element`, concatenated and trimmed. */
export function textOf(element: XmlElement | undefined): string {
  if (element === undefined) return '';
  let out = '';
  const walk = (node: XmlElement): void => {
    for (const child of node.children) {
      if (typeof child === 'string') out += child;
      else walk(child);
    }
  };
  walk(element);
  return out.trim();
}

/** The trimmed text of the first child called `name`, or `null` when absent or empty. */
export function childText(element: XmlElement, name: string): string | null {
  const text = textOf(firstChild(element, name));
  return text === '' ? null : text;
}
