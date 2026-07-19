import { describe, expect, it, vi } from 'vitest';
import {
  deliverReplicaRecoveryExport,
  isExpiredRecoveryExportFile,
  purgeStaleReplicaRecoveryExports,
  RECOVERY_EXPORT_CACHE_RETENTION_MS,
  RecoveryExportDeliveryError,
  type NativeRecoveryExportPort,
} from './export-sink.native';

function nativePort(
  options: {
    available?: boolean;
    observed?: string;
    switchOwnerDuringRead?: () => void;
    deleteError?: Error;
    cleanupError?: Error;
    shareError?: Error;
  } = {},
) {
  const events: string[] = [];
  let written = '';
  const file = {
    uri: 'file:///cache/iris-recovery.json',
    create: vi.fn(() => events.push('create')),
    write: vi.fn((content: string) => {
      written = content;
      events.push('write');
    }),
    readText: vi.fn(async () => {
      events.push('read');
      options.switchOwnerDuringRead?.();
      return options.observed ?? written;
    }),
    delete: vi.fn(() => {
      events.push('delete');
      if (options.deleteError) throw options.deleteError;
    }),
  };
  const port: NativeRecoveryExportPort = {
    isSharingAvailable: vi.fn(async () => {
      events.push('available');
      return options.available ?? true;
    }),
    cleanupStaleFiles: vi.fn(() => {
      events.push('cleanup');
      if (options.cleanupError) throw options.cleanupError;
    }),
    createCacheFile: vi.fn(() => file),
    shareFile: vi.fn(async () => {
      events.push('share');
      if (options.shareError) throw options.shareError;
    }),
  };
  return { port, file, events, written: () => written };
}

describe('native recovery export delivery', () => {
  it('deletes only files with a known positive timestamp older than the cutoff', () => {
    const cutoff = 2_000_000_000_000;

    expect(isExpiredRecoveryExportFile({}, cutoff)).toBe(false);
    expect(
      isExpiredRecoveryExportFile({ modificationTime: null, creationTime: null }, cutoff),
    ).toBe(false);
    expect(isExpiredRecoveryExportFile({ modificationTime: 0, creationTime: 0 }, cutoff)).toBe(
      false,
    );
    expect(
      isExpiredRecoveryExportFile(
        { modificationTime: Number.NaN, creationTime: cutoff - 1 },
        cutoff,
      ),
    ).toBe(true);
    expect(
      isExpiredRecoveryExportFile({ modificationTime: cutoff, creationTime: cutoff - 1 }, cutoff),
    ).toBe(false);
    expect(isExpiredRecoveryExportFile({ creationTime: cutoff - 1 }, cutoff)).toBe(true);
  });

  it('writes, verifies, and retains the exact handed-off cache file without network work', async () => {
    const fake = nativePort();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await deliverReplicaRecoveryExport(
      '{"exact":true}',
      'iris-recovery.json',
      undefined,
      async () => fake.port,
    );

    expect(fake.written()).toBe('{"exact":true}');
    expect(fake.port.shareFile).toHaveBeenCalledWith(fake.file.uri);
    expect(result).toEqual({
      kind: 'share-sheet-closed',
      temporaryFileRetained: true,
      staleCacheCleanupFailed: false,
    });
    expect(fake.events).toEqual(['available', 'cleanup', 'create', 'write', 'read', 'share']);
    expect(fake.file.delete).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('removes the cache file and refuses to share when the owner changes during verification', async () => {
    let current = true;
    const fake = nativePort({ switchOwnerDuringRead: () => (current = false) });
    const guard = () => {
      if (!current) throw new Error('stale owner');
    };

    await expect(
      deliverReplicaRecoveryExport('{}', 'iris-recovery.json', guard, async () => fake.port),
    ).rejects.toBeInstanceOf(RecoveryExportDeliveryError);
    expect(fake.port.shareFile).not.toHaveBeenCalled();
    expect(fake.events.at(-1)).toBe('delete');
  });

  it('refuses mismatched bytes and unavailable sharing', async () => {
    const mismatch = nativePort({ observed: 'different' });
    await expect(
      deliverReplicaRecoveryExport(
        '{}',
        'iris-recovery.json',
        undefined,
        async () => mismatch.port,
      ),
    ).rejects.toThrow('could not be verified');
    expect(mismatch.port.shareFile).not.toHaveBeenCalled();
    expect(mismatch.events.at(-1)).toBe('delete');

    const unavailable = nativePort({ available: false });
    await expect(
      deliverReplicaRecoveryExport(
        '{}',
        'iris-recovery.json',
        undefined,
        async () => unavailable.port,
      ),
    ).rejects.toThrow('unavailable');
    expect(unavailable.port.createCacheFile).not.toHaveBeenCalled();
  });

  it('reports stale-cache cleanup failure without blocking a separately named export', async () => {
    const cleanupFailure = nativePort({ cleanupError: new Error('cleanup failed') });
    const result = await deliverReplicaRecoveryExport(
      '{}',
      'iris-recovery.json',
      undefined,
      async () => cleanupFailure.port,
    );

    expect(result).toEqual({
      kind: 'share-sheet-closed',
      temporaryFileRetained: true,
      staleCacheCleanupFailed: true,
    });
    expect(cleanupFailure.events).toEqual([
      'available',
      'cleanup',
      'create',
      'write',
      'read',
      'share',
    ]);
  });

  it('preserves the original delivery error and discloses a failed cache-file removal', async () => {
    const mismatch = nativePort({
      observed: 'different',
      deleteError: new Error('cleanup also failed'),
    });
    await expect(
      deliverReplicaRecoveryExport(
        '{}',
        'iris-recovery.json',
        undefined,
        async () => mismatch.port,
      ),
    ).rejects.toThrow(/could not be verified.*may remain in Iris's private cache/);
  });

  it('retains a file once the native share handoff starts, even if the share API rejects', async () => {
    const fake = nativePort({ shareError: new Error('share failed') });

    await expect(
      deliverReplicaRecoveryExport('{}', 'iris-recovery.json', undefined, async () => fake.port),
    ).rejects.toThrow('temporary recovery file was retained');
    expect(fake.events.at(-1)).toBe('share');
    expect(fake.file.delete).not.toHaveBeenCalled();
  });

  it('purges only through the dedicated stale-cache port with the retention cutoff', async () => {
    const fake = nativePort();
    const now = 2_000_000_000_000;

    await purgeStaleReplicaRecoveryExports(now, async () => fake.port);

    expect(fake.port.cleanupStaleFiles).toHaveBeenCalledWith(
      now - RECOVERY_EXPORT_CACHE_RETENTION_MS,
    );
    expect(fake.port.createCacheFile).not.toHaveBeenCalled();
    expect(fake.port.shareFile).not.toHaveBeenCalled();
  });
});
