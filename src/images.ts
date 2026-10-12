import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Local product image cache. Images come from the Open *Facts servers; we download each one once, keep it in
 * IMAGE_DIR and serve it from /img/<file>, so the thumbnails don't hit the public servers on every page view.
 */

const ALLOWED_HOSTS = /(^|\.)(openfoodfacts|openbeautyfacts|openproductsfacts|openpetfoodfacts)\.org$/i;
const MAX_BYTES = 2 * 1024 * 1024;
export const FILE_RE = /^[0-9A-Za-z_-]{3,40}\.(jpg|png|webp)$/;

export function isAllowedImageUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && ALLOWED_HOSTS.test(url.hostname);
  } catch {
    return false;
  }
}

/** Detects the image type from the first bytes (never trust the Content-Type header alone). */
export function sniffImage(b: Uint8Array): 'jpg' | 'png' | 'webp' | null {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 12 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length > 12 && String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!) === 'RIFF' && String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!) === 'WEBP') return 'webp';
  return null;
}

export const contentTypeOf = (file: string) => (file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
export const imageFilePath = (file: string) => path.join(config.imageDir, file);
export const hasImageFile = (file: string | null | undefined) => !!file && FILE_RE.test(file) && fs.existsSync(imageFilePath(file));

/** Short version tag so a changed source image gets a new URL (the browser may cache /img/ "forever"). */
export const versionOf = (sourceUrl: string) => crypto.createHash('sha1').update(sourceUrl).digest('hex').slice(0, 8);
export const localUrl = (file: string, sourceUrl: string) => `/img/${file}?v=${versionOf(sourceUrl)}`;

const safeName = (barcode: string) => barcode.replace(/[^0-9A-Za-z_-]/g, '').slice(0, 40);

/** Downloads one image into the cache. Returns the file name, or null when it could not be fetched / is not an image. */
export async function downloadImage(barcode: string, remote: string): Promise<string | null> {
  if (!isAllowedImageUrl(remote)) return null;
  const name = safeName(barcode);
  if (name.length < 3) return null;
  try {
    const res = await fetch(remote, { headers: { 'User-Agent': config.offUserAgent }, signal: AbortSignal.timeout(8000), redirect: 'error' });
    if (!res.ok) return null;
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_BYTES) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length === 0 || buf.length > MAX_BYTES) return null;
    const ext = sniffImage(buf);
    if (!ext) return null;
    fs.mkdirSync(config.imageDir, { recursive: true });
    const file = `${name}.${ext}`;
    const tmp = imageFilePath(`${file}.part`);
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, imageFilePath(file)); // atomic: a reader never sees a half-written file
    for (const other of ['jpg', 'png', 'webp']) if (other !== ext) fs.rmSync(imageFilePath(`${name}.${other}`), { force: true });
    return file;
  } catch {
    return null;
  }
}

export function imageStats(): { count: number; bytes: number } {
  try {
    const files = fs.readdirSync(config.imageDir).filter((f) => FILE_RE.test(f));
    return { count: files.length, bytes: files.reduce((n, f) => n + fs.statSync(imageFilePath(f)).size, 0) };
  } catch {
    return { count: 0, bytes: 0 };
  }
}

export function clearImageFiles(): number {
  let n = 0;
  try {
    for (const f of fs.readdirSync(config.imageDir)) {
      if (FILE_RE.test(f) || f.endsWith('.part')) {
        fs.rmSync(imageFilePath(f), { force: true });
        n++;
      }
    }
  } catch {
    /* directory does not exist yet */
  }
  return n;
}
