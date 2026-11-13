import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  loadOmpImages,
  mimeTypeForImagePath,
  OMP_IMAGE_BUDGET_BYTES,
} from '../../../src/agent/omp/images.js';

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('omp image payloads', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'omp-images-'));
    cleanup.push(dir);
    return dir;
  }

  it('infers the MIME type from the file extension', () => {
    expect(mimeTypeForImagePath('/tmp/a.png')).toBe('image/png');
    expect(mimeTypeForImagePath('/tmp/a.JPG')).toBe('image/jpeg');
    expect(mimeTypeForImagePath('/tmp/a.jpeg')).toBe('image/jpeg');
    expect(mimeTypeForImagePath('/tmp/a.webp')).toBe('image/webp');
    expect(mimeTypeForImagePath('/tmp/a.bin')).toBeUndefined();
    expect(mimeTypeForImagePath('/tmp/no-extension')).toBeUndefined();
  });

  it('encodes accepted images as base64 ImageContent entries', async () => {
    const dir = await tempDir();
    const path = join(dir, 'shot.png');
    await writeFile(path, PNG_1PX);

    expect(await loadOmpImages([path])).toEqual([
      { type: 'image', mimeType: 'image/png', data: PNG_1PX.toString('base64') },
    ]);
  });

  it('returns nothing when there are no image paths', async () => {
    expect(await loadOmpImages(undefined)).toEqual([]);
    expect(await loadOmpImages([])).toEqual([]);
  });

  it('skips images that would push the prompt frame past the transport budget', async () => {
    const dir = await tempDir();
    const small = join(dir, 'small.png');
    const huge = join(dir, 'huge.png');
    await writeFile(small, PNG_1PX);
    // Base64 of this buffer alone exceeds the whole budget.
    await writeFile(huge, Buffer.alloc(OMP_IMAGE_BUDGET_BYTES + 1024));

    const images = await loadOmpImages([huge, small]);

    expect(images).toHaveLength(1);
    expect(images[0]?.data).toBe(PNG_1PX.toString('base64'));
  });

  it('skips unreadable and non-image paths without failing the run', async () => {
    expect(await loadOmpImages(['/nonexistent/dir/missing.png'])).toEqual([]);

    const dir = await tempDir();
    const notAnImage = join(dir, 'notes.txt');
    await writeFile(notAnImage, 'hello');
    expect(await loadOmpImages([notAnImage])).toEqual([]);
  });
});
