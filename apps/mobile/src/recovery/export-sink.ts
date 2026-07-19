export type RecoveryExportGuard = () => void;

export type RecoveryExportDeliveryResult =
  | { kind: 'download-requested' }
  | {
      kind: 'share-sheet-closed';
      temporaryFileRetained: true;
      staleCacheCleanupFailed: boolean;
    };

interface WebRecoveryExportAnchor {
  href: string;
  download: string;
  click(): void;
  remove(): void;
}

export interface WebRecoveryExportPort {
  createJsonBlob(content: string): unknown;
  createObjectUrl(blob: unknown): string;
  revokeObjectUrl(url: string): void;
  createAnchor(): WebRecoveryExportAnchor;
  appendAnchor(anchor: WebRecoveryExportAnchor): void;
  waitForDownloadRequest(): Promise<void>;
}

export class RecoveryExportDeliveryError extends Error {
  readonly delivery?: RecoveryExportDeliveryResult;

  constructor(
    message: string,
    options?: { cause?: unknown; delivery?: RecoveryExportDeliveryResult },
  ) {
    super(message, options);
    this.name = 'RecoveryExportDeliveryError';
    this.delivery = options?.delivery;
  }
}

function browserPort(): WebRecoveryExportPort {
  const browser = globalThis as unknown as {
    Blob?: new (parts: string[], options: { type: string }) => unknown;
    URL?: {
      createObjectURL?: (blob: unknown) => string;
      revokeObjectURL?: (url: string) => void;
    };
    document?: {
      body?: {
        appendChild(anchor: WebRecoveryExportAnchor): void;
      };
      createElement?: (tag: string) => {
        href: string;
        download: string;
        click(): void;
        remove(): void;
        style?: { display?: string };
      };
    };
  };
  if (
    !browser.Blob ||
    !browser.URL?.createObjectURL ||
    !browser.URL.revokeObjectURL ||
    !browser.document?.createElement ||
    !browser.document.body?.appendChild
  ) {
    throw new RecoveryExportDeliveryError('This browser cannot download a recovery export');
  }
  return {
    createJsonBlob: (content) =>
      new browser.Blob!([content], { type: 'application/json;charset=utf-8' }),
    createObjectUrl: (blob) => browser.URL!.createObjectURL!(blob),
    revokeObjectUrl: (url) => browser.URL!.revokeObjectURL!(url),
    createAnchor: () => {
      const anchor = browser.document!.createElement!('a');
      if (anchor.style) anchor.style.display = 'none';
      return anchor;
    },
    appendAnchor: (anchor) => browser.document!.body!.appendChild(anchor),
    waitForDownloadRequest: () =>
      new Promise((resolve) => {
        setTimeout(resolve, 0);
      }),
  };
}

/** Request a browser download without any request to the Iris API. */
export async function deliverReplicaRecoveryExport(
  serializedExport: string,
  fileName: string,
  guard: RecoveryExportGuard = () => undefined,
  port: WebRecoveryExportPort = browserPort(),
): Promise<RecoveryExportDeliveryResult> {
  guard();
  let url: string | null = null;
  let anchor: WebRecoveryExportAnchor | null = null;
  let appended = false;
  let downloadRequested = false;
  try {
    const blob = port.createJsonBlob(serializedExport);
    url = port.createObjectUrl(blob);
    anchor = port.createAnchor();
    anchor.href = url;
    anchor.download = fileName;
    port.appendAnchor(anchor);
    appended = true;
    guard();
    anchor.click();
    downloadRequested = true;
    await port.waitForDownloadRequest();
    guard();
    return { kind: 'download-requested' };
  } catch (cause) {
    if (cause instanceof RecoveryExportDeliveryError) throw cause;
    throw new RecoveryExportDeliveryError(
      downloadRequested
        ? 'The recovery download was requested, but its final freshness check failed'
        : 'Could not download the recovery export',
      {
        cause,
        delivery: downloadRequested ? { kind: 'download-requested' } : undefined,
      },
    );
  } finally {
    try {
      if (appended) anchor?.remove();
    } finally {
      if (url) port.revokeObjectUrl(url);
    }
  }
}

/** Web downloads do not leave an Iris-owned native cache file. */
export function purgeStaleReplicaRecoveryExports(): Promise<void> {
  return Promise.resolve();
}
