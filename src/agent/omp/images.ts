import { readFile } from 'node:fs/promises';
import { log } from '../../core/logger';

/** Wire shape carried by OMP's RPC `prompt.images`. */
export interface OmpImageContent {
  type: 'image';
  mimeType: string;
  data: string;
}

/**
 * OMP advertises `maxFrameBytes: 1048576` for physical frames and never
 * reassembles inbound input, so an oversized prompt frame is the client's
 * problem. Base64 inflates by 4/3 and the frame also carries the message text
 * and attachment metadata, so keep the encoded images well under 1 MiB.
 */
export const OMP_IMAGE_BUDGET_BYTES = 720 * 1024;

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
};

/** MIME type for a downloaded image path, inferred from its extension. */
export function mimeTypeForImagePath(path: string): string | undefined {
  const dot = path.lastIndexOf('.');
  if (dot === -1) {
    return undefined;
  }
  return MIME_BY_EXTENSION[path.slice(dot + 1).toLowerCase()];
}

/**
 * Read downloaded image files into RPC `ImageContent` entries.
 *
 * Anything that cannot be sent safely is skipped rather than failing the run:
 * the prompt already lists every accepted attachment with its local path, so
 * the agent can still open a dropped image with its `read` tool.
 */
export async function loadOmpImages(
  paths: readonly string[] | undefined,
): Promise<OmpImageContent[]> {
  if (!paths || paths.length === 0) {
    return [];
  }
  const images: OmpImageContent[] = [];
  let budgetUsed = 0;
  for (const path of paths) {
    const mimeType = mimeTypeForImagePath(path);
    if (!mimeType) {
      log.warn('agent', 'omp-image-skipped', { reason: 'unsupported-extension', path });
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (err) {
      log.warn('agent', 'omp-image-skipped', {
        reason: 'read-failed',
        path,
        message: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const encoded = bytes.toString('base64');
    if (budgetUsed + encoded.length > OMP_IMAGE_BUDGET_BYTES) {
      log.warn('agent', 'omp-image-skipped', {
        reason: 'over-frame-budget',
        path,
        bytes: bytes.length,
        budgetUsed,
      });
      continue;
    }
    budgetUsed += encoded.length;
    images.push({ type: 'image', mimeType, data: encoded });
  }
  if (images.length > 0) {
    log.info('agent', 'omp-images', { count: images.length, encodedBytes: budgetUsed });
  }
  return images;
}
