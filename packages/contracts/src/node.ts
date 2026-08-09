/**
 * The Node-only half of the contracts package: everything that needs a platform API.
 *
 * `detection_uid` has exactly one implementation (GLOSSARY §1b rule 5) and it lives
 * here. It is a separate entry point so the browser bundle can import the vocabulary
 * and the canonicalization rules without pulling `node:crypto` in.
 */

import { createHash } from 'node:crypto';

import { detectionUidPreimage, type DetectionUidParts } from './detection-uid.js';

export function detectionUid(parts: DetectionUidParts): string {
  return createHash('sha256').update(detectionUidPreimage(parts), 'utf8').digest('hex');
}
