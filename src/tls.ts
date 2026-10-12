import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import selfsigned from 'selfsigned';
import { config } from './config.js';

/**
 * Browsers only allow camera access on HTTPS (or localhost). For the phone camera scanner the app can therefore
 * serve the same UI over HTTPS with a self-signed certificate (accept the browser warning once per device).
 * The certificate is kept in CERT_DIR and recreated when the list of host names/IPs changes.
 */
export interface Tls {
  key: string;
  cert: string;
  hosts: string[];
}

function hostList(): string[] {
  const hosts = new Set<string>(['localhost', '127.0.0.1', os.hostname()]);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4') hosts.add(a.address);
  }
  for (const h of config.tlsHosts) hosts.add(h);
  return [...hosts].filter(Boolean).sort();
}

const isIp = (h: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h);

export async function loadOrCreateTls(): Promise<Tls | null> {
  if (!config.httpsPort) return null;
  const hosts = hostList();
  const dir = config.certDir;
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const hostsFile = path.join(dir, 'hosts.txt');
  try {
    if (fs.existsSync(keyFile) && fs.existsSync(certFile) && fs.readFileSync(hostsFile, 'utf8') === hosts.join('\n')) {
      return { key: fs.readFileSync(keyFile, 'utf8'), cert: fs.readFileSync(certFile, 'utf8'), hosts };
    }
  } catch {
    /* regenerate below */
  }
  const notBeforeDate = new Date();
  const notAfterDate = new Date(notBeforeDate.getTime() + 397 * 24 * 3600 * 1000);
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Beepstock' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notBeforeDate,
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true },
      { name: 'subjectAltName', altNames: hosts.map((h) => (isIp(h) ? { type: 7, ip: h } : { type: 2, value: h })) },
    ],
  });
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keyFile, pems.private, { mode: 0o600 });
    fs.writeFileSync(certFile, pems.cert);
    fs.writeFileSync(hostsFile, hosts.join('\n'));
  } catch (e) {
    console.warn(`TLS: could not persist the certificate in ${dir} (${e instanceof Error ? e.message : e}); it will change on restart`);
  }
  return { key: pems.private, cert: pems.cert, hosts };
}
