// tangram-layers
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/** The range requests to one archive URL. */
export type ArchiveReads = {
  /** Range requests sent. */
  requests: number;
  /** Bytes that the range responses hold, by their `Content-Length`. */
  bytes: number;
  /** The size of the whole archive, from `Content-Range`, or null before the first response. */
  archiveSize: number | null;
  /** Why the last request failed, or null. A later response that is OK clears it. */
  error: string | null;
};

/** The total size in a `Content-Range` header such as `bytes 0-16383/6601156`, or null. */
export function parseArchiveSize(contentRange: string | null): number | null {
  const match = contentRange?.match(/^bytes (?:\d+-\d+|\*)\/(\d+)$/);
  return match ? Number(match[1]) : null;
}

/**
 * A `fetch` for `loadOptions.fetch` that records the range requests to each archive URL in
 * `reads`, and calls `onChange` after each one. Other requests, such as glyphs, pass through and
 * are not recorded. Pass the same function on every render: the archive readers are kept per
 * `fetch`.
 */
export function createRangeReadFetch(
  reads: Map<string, ArchiveReads>,
  onChange: () => void,
  fetchFn: typeof fetch = (input, init) => fetch(input, init)
): typeof fetch {
  return async (input, init) => {
    const range = new Headers(init?.headers).get('Range');
    if (!range) {
      return fetchFn(input, init);
    }
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let entry = reads.get(url);
    if (!entry) {
      entry = {requests: 0, bytes: 0, archiveSize: null, error: null};
      reads.set(url, entry);
    }
    entry.requests++;
    try {
      const response = await fetchFn(input, init);
      if (response.ok) {
        entry.bytes += Number(response.headers.get('Content-Length')) || 0;
        entry.archiveSize = parseArchiveSize(response.headers.get('Content-Range')) ?? entry.archiveSize;
        entry.error = null;
      } else {
        entry.error = `The archive did not load: HTTP ${response.status}`;
      }
      return response;
    } catch (error) {
      // A tile that leaves the view cancels its request. That is not a failure.
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        entry.error = `The archive did not load: ${error instanceof Error ? error.message : String(error)}`;
      }
      throw error;
    } finally {
      onChange();
    }
  };
}

/** A byte count such as `840 B`, `52.4 kB` or `6.60 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) {
    return `${bytes} B`;
  }
  if (bytes < 1e6) {
    return `${(bytes / 1e3).toFixed(1)} kB`;
  }
  return `${(bytes / 1e6).toFixed(2)} MB`;
}

/**
 * The readout lines for the range requests to one archive. `knownSize` is the size of the archive
 * when the responses do not give it: a cross-origin response exposes `Content-Range` only when the
 * server lists it in `Access-Control-Expose-Headers`.
 */
export function getReadsText(reads: ArchiveReads | undefined, knownSize?: number): string[] {
  if (!reads) {
    return ['Range requests: 0'];
  }
  const lines = [];
  if (reads.error) {
    lines.push(`**${escapeMarkdown(reads.error)}**`);
  }
  lines.push(`Range requests: ${reads.requests}`);
  const read = formatBytes(reads.bytes);
  const archiveSize = reads.archiveSize ?? knownSize;
  if (archiveSize) {
    const percent = (100 * reads.bytes) / archiveSize;
    lines.push(
      `Bytes read: ${read} of ${formatBytes(archiveSize)} (${percent < 1 ? percent.toFixed(2) : percent.toFixed(1)} %)`
    );
  } else {
    lines.push(`Bytes read: ${read}`);
  }
  return lines;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\*_`[\]]/g, character => `\\${character}`);
}
