/**
 * Builds the configured backup store (R2 or a local directory) for the two backup CLIs, so
 * the backup and the restore cannot wire the same configuration two different ways.
 */

import { createLocalFsBackupStore } from '../adapters/backup/local-fs-backup-store.js';
import { createR2BackupStore } from '../adapters/backup/r2-backup-store.js';
import type { BackupObjectReader, BackupObjectWriter } from '../core/backup/ports.js';
import type { Clock } from '../core/ports/clock.js';
import type { BackupStoreConfig } from './backup-config.js';

export function createConfiguredBackupStore(
  store: BackupStoreConfig,
  clock: Clock,
  onSwept: (key: string) => void,
): BackupObjectWriter & BackupObjectReader {
  if (store.kind === 'local') {
    return createLocalFsBackupStore({ root: store.directory, clock, onSwept });
  }
  return createR2BackupStore({
    endpoint: store.endpoint,
    bucket: store.bucket,
    credentials: { accessKeyId: store.accessKeyId, secretAccessKey: store.secretAccessKey },
    clock,
  });
}
