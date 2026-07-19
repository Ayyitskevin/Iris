import type { RecoveryExportDeliveryResult, RecoveryExportGuard } from './export-sink';

export const RECOVERY_EXPORT_CACHE_RETENTION_MS = 24 * 60 * 60 * 1_000;

export interface NativeRecoveryExportFile {
  uri: string;
  create(): void;
  write(content: string): void;
  readText(): Promise<string>;
  delete(): void | Promise<void>;
}

export interface NativeRecoveryExportPort {
  isSharingAvailable(): Promise<boolean>;
  cleanupStaleFiles(olderThan: number): void | Promise<void>;
  createCacheFile(fileName: string): NativeRecoveryExportFile;
  shareFile(uri: string): Promise<void>;
}

export interface NativeRecoveryExportFileInfo {
  modificationTime?: number | null;
  creationTime?: number | null;
}

/** Unknown, zero, negative, or non-finite timestamps are not evidence that a file expired. */
export function isExpiredRecoveryExportFile(
  info: NativeRecoveryExportFileInfo,
  olderThan: number,
): boolean {
  const timestamp = [info.modificationTime, info.creationTime].find(
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0,
  );
  return timestamp !== undefined && timestamp < olderThan;
}

export class RecoveryExportDeliveryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RecoveryExportDeliveryError';
  }
}

async function nativePort(): Promise<NativeRecoveryExportPort> {
  const [fileSystem, sharing] = await Promise.all([
    import('expo-file-system'),
    import('expo-sharing'),
  ]);
  const exportDirectory = new fileSystem.Directory(fileSystem.Paths.cache, 'iris-recovery-exports');
  const ensureExportDirectory = () =>
    exportDirectory.create({ idempotent: true, intermediates: true });
  return {
    isSharingAvailable: () => sharing.isAvailableAsync(),
    cleanupStaleFiles: (olderThan) => {
      ensureExportDirectory();
      for (const entry of exportDirectory.list()) {
        if (!(entry instanceof fileSystem.File)) continue;
        const info = entry.info();
        if (isExpiredRecoveryExportFile(info, olderThan)) entry.delete();
      }
    },
    createCacheFile: (fileName) => {
      ensureExportDirectory();
      const file = new fileSystem.File(exportDirectory, fileName);
      return {
        uri: file.uri,
        create: () => file.create({ overwrite: true }),
        write: (content) => file.write(content),
        readText: () => file.text(),
        delete: () => file.delete(),
      };
    },
    shareFile: (uri) =>
      sharing.shareAsync(uri, {
        dialogTitle: 'Export Iris recovery copies',
        mimeType: 'application/json',
        UTI: 'public.json',
      }),
  };
}

/**
 * Verify a private cache file byte-for-byte immediately before opening the native share sheet.
 * Once handed off, the file stays in Iris's cache so a slow Android receiver can still consume it.
 * A later app launch/export attempts to remove files with verified timestamps beyond retention.
 */
export async function deliverReplicaRecoveryExport(
  serializedExport: string,
  fileName: string,
  guard: RecoveryExportGuard = () => undefined,
  loadPort: () => Promise<NativeRecoveryExportPort> = nativePort,
): Promise<RecoveryExportDeliveryResult> {
  let file: NativeRecoveryExportFile | null = null;
  let handedOff = false;
  let staleCacheCleanupFailed = false;
  let operationError: unknown;
  try {
    guard();
    const port = await loadPort();
    guard();
    if (!(await port.isSharingAvailable())) {
      throw new RecoveryExportDeliveryError('File sharing is unavailable on this device');
    }
    guard();
    try {
      await port.cleanupStaleFiles(Date.now() - RECOVERY_EXPORT_CACHE_RETENTION_MS);
    } catch {
      // An undeletable old file must not prevent a separately named export. Return the warning
      // to the UI while keeping creation, exact-byte verification, and sharing fail-closed.
      staleCacheCleanupFailed = true;
    }
    guard();
    file = port.createCacheFile(fileName);
    guard();
    file.create();
    file.write(serializedExport);
    const observed = await file.readText();
    guard();
    if (observed !== serializedExport) {
      throw new RecoveryExportDeliveryError('The temporary recovery export could not be verified');
    }
    guard();
    handedOff = true;
    await port.shareFile(file.uri);
  } catch (cause) {
    operationError =
      cause instanceof RecoveryExportDeliveryError
        ? cause
        : new RecoveryExportDeliveryError(
            handedOff
              ? "Sharing did not complete. A temporary recovery file was retained in Iris's private cache for a later cleanup attempt." +
                  (staleCacheCleanupFailed
                    ? ' Older temporary recovery files could not be cleaned during this attempt.'
                    : '')
              : 'Could not share the recovery export',
            { cause },
          );
  }

  if (file && !handedOff) {
    try {
      await file.delete();
    } catch (cause) {
      const primaryMessage =
        operationError instanceof Error
          ? operationError.message
          : 'The recovery export could not be completed';
      operationError = new RecoveryExportDeliveryError(
        `${primaryMessage}. The temporary recovery file could not be removed and may remain in Iris's private cache.`,
        { cause: { deliveryError: operationError, removalError: cause } },
      );
    }
  }
  if (operationError) throw operationError;
  return {
    kind: 'share-sheet-closed',
    temporaryFileRetained: true,
    staleCacheCleanupFailed,
  };
}

/** Remove only expired files from Iris's dedicated recovery-export cache directory. */
export async function purgeStaleReplicaRecoveryExports(
  nowMs: number = Date.now(),
  loadPort: () => Promise<NativeRecoveryExportPort> = nativePort,
): Promise<void> {
  try {
    const port = await loadPort();
    await port.cleanupStaleFiles(nowMs - RECOVERY_EXPORT_CACHE_RETENTION_MS);
  } catch (cause) {
    throw new RecoveryExportDeliveryError('Could not clean stale recovery export cache files', {
      cause,
    });
  }
}
