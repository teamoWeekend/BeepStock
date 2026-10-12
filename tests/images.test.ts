import { describe, expect, it } from 'vitest';
import { FILE_RE, isAllowedImageUrl, localUrl, sniffImage, versionOf } from '../src/images.js';

describe('image cache helpers', () => {
  it('only accepts https images from the Open *Facts domains', () => {
    expect(isAllowedImageUrl('https://images.openfoodfacts.org/images/products/301/762/042/2003/front_en.879.200.jpg')).toBe(true);
    expect(isAllowedImageUrl('https://static.openbeautyfacts.org/images/x.jpg')).toBe(true);
    expect(isAllowedImageUrl('http://images.openfoodfacts.org/x.jpg')).toBe(false); // not https
    expect(isAllowedImageUrl('https://evil.example.com/openfoodfacts.org/x.jpg')).toBe(false);
    expect(isAllowedImageUrl('https://openfoodfacts.org.evil.com/x.jpg')).toBe(false);
    expect(isAllowedImageUrl('https://localhost/x.jpg')).toBe(false);
    expect(isAllowedImageUrl('not a url')).toBe(false);
  });
  it('detects image types from magic bytes', () => {
    const pad = (a: number[]) => Uint8Array.from([...a, ...new Array(16).fill(0)]);
    expect(sniffImage(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(sniffImage(pad([0x89, 0x50, 0x4e, 0x47]))).toBe('png');
    expect(sniffImage(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0]))).toBe('webp');
    expect(sniffImage(new TextEncoder().encode('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffImage(new Uint8Array(0))).toBeNull();
  });
  it('only serves safe file names', () => {
    expect(FILE_RE.test('3017620422003.jpg')).toBe(true);
    expect(FILE_RE.test('../etc/passwd')).toBe(false);
    expect(FILE_RE.test('a/b.jpg')).toBe(false);
    expect(FILE_RE.test('x.svg')).toBe(false);
  });
  it('versions the local URL by the source URL', () => {
    expect(versionOf('https://a')).not.toBe(versionOf('https://b'));
    expect(localUrl('123.jpg', 'https://a')).toMatch(/^\/img\/123\.jpg\?v=[0-9a-f]{8}$/);
  });
});
