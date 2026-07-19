import { describe, expect, it, vi } from 'vitest';
import {
  deliverReplicaRecoveryExport,
  RecoveryExportDeliveryError,
  type WebRecoveryExportPort,
} from './export-sink';

function webPort(options: { clickError?: Error } = {}) {
  const events: string[] = [];
  let content = '';
  let mime = '';
  const anchor = {
    href: '',
    download: '',
    click: vi.fn(() => {
      events.push('click');
      if (options.clickError) throw options.clickError;
    }),
    remove: vi.fn(() => {
      events.push('remove');
    }),
  };
  const port: WebRecoveryExportPort = {
    createJsonBlob(value) {
      events.push('blob');
      content = value;
      mime = 'application/json;charset=utf-8';
      return { value };
    },
    createObjectUrl() {
      events.push('url');
      return 'blob:recovery';
    },
    revokeObjectUrl(url) {
      events.push('revoke:' + url);
    },
    createAnchor() {
      events.push('anchor');
      return anchor;
    },
    appendAnchor() {
      events.push('append');
    },
    async waitForDownloadRequest() {
      events.push('settle');
    },
  };
  return { port, events, anchor, content: () => content, mime: () => mime };
}

describe('web recovery export delivery', () => {
  it('downloads the exact JSON bytes once and always revokes the object URL', async () => {
    const fake = webPort();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await deliverReplicaRecoveryExport(
      '{"exact":true}',
      'iris-recovery.json',
      undefined,
      fake.port,
    );

    expect(fake.content()).toBe('{"exact":true}');
    expect(fake.mime()).toBe('application/json;charset=utf-8');
    expect(fake.anchor).toMatchObject({
      href: 'blob:recovery',
      download: 'iris-recovery.json',
    });
    expect(fake.anchor.click).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ kind: 'download-requested' });
    expect(fake.events).toEqual([
      'blob',
      'url',
      'anchor',
      'append',
      'click',
      'settle',
      'remove',
      'revoke:blob:recovery',
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('revokes the object URL and reports an anchor failure', async () => {
    const fake = webPort({ clickError: new Error('blocked click') });

    await expect(
      deliverReplicaRecoveryExport('{}', 'iris-recovery.json', undefined, fake.port),
    ).rejects.toBeInstanceOf(RecoveryExportDeliveryError);
    expect(fake.events).toContain('remove');
    expect(fake.events.at(-1)).toBe('revoke:blob:recovery');
  });

  it('rechecks owner freshness immediately before clicking', async () => {
    const fake = webPort();
    let checks = 0;
    const guard = () => {
      checks += 1;
      if (checks === 2) throw new Error('stale owner');
    };

    await expect(
      deliverReplicaRecoveryExport('{}', 'iris-recovery.json', guard, fake.port),
    ).rejects.toBeInstanceOf(RecoveryExportDeliveryError);
    expect(fake.anchor.click).not.toHaveBeenCalled();
    expect(fake.events).toContain('remove');
    expect(fake.events.at(-1)).toBe('revoke:blob:recovery');
  });

  it('reports that download was already requested when the post-click freshness check fails', async () => {
    const fake = webPort();
    let checks = 0;
    const guard = () => {
      checks += 1;
      if (checks === 3) throw new Error('projection changed');
    };

    await expect(
      deliverReplicaRecoveryExport('{}', 'iris-recovery.json', guard, fake.port),
    ).rejects.toMatchObject({ delivery: { kind: 'download-requested' } });
    expect(fake.anchor.click).toHaveBeenCalledTimes(1);
    expect(fake.events).toContain('settle');
    expect(fake.events.at(-1)).toBe('revoke:blob:recovery');
  });
});
