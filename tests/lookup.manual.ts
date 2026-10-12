// Manual smoke test against the real Open *Facts APIs (network needed):  npx tsx tests/lookup.manual.ts <barcode...>
import { fetchOff, SOURCE_LABEL } from '../src/off.js';

const codes = process.argv.slice(2);
for (const code of codes.length ? codes : ['4066447341942', '3017620422003', '0000000000017']) {
  const r = await fetchOff(code);
  if (r.status === 'found') console.log(code, '->', r.product.name, `(${r.product.brand ?? '-'})`, '|', SOURCE_LABEL[r.product.source] ?? r.product.source);
  else console.log(code, '->', r.status, r.status === 'error' ? r.error : '');
}
