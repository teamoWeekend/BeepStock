const env = process.env;

export const config = {
  port: parseInt(env.PORT ?? '8080', 10),
  databaseUrl: env.DATABASE_URL ?? 'postgres://pantry:pantry@localhost:5432/pantry',
  /** If set, /api and /ws require `Authorization: Bearer <token>` or `?token=`. */
  apiToken: env.API_TOKEN ?? '',
  offBase: env.OFF_BASE_URL ?? 'https://world.openfoodfacts.org',
  /** Open *Facts sister databases (same API): queried in this order until one knows the barcode. */
  lookupSources: (env.LOOKUP_SOURCES ?? 'off,obf,opf,opff').split(',').map((s) => s.trim()).filter(Boolean),
  obfBase: env.OBF_BASE_URL ?? 'https://world.openbeautyfacts.org',
  opfBase: env.OPF_BASE_URL ?? 'https://world.openproductsfacts.org',
  opffBase: env.OPFF_BASE_URL ?? 'https://world.openpetfoodfacts.org',
  /** HTTPS port for the phone camera (browsers need a secure context for getUserMedia). 0 = off. */
  httpsPort: parseInt(env.HTTPS_PORT ?? '0', 10),
  certDir: env.CERT_DIR ?? '/data/certs',
  /** Extra host names / IPs for the self-signed certificate, e.g. the LAN IP of the server. */
  tlsHosts: (env.TLS_HOSTS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  /** Automatic safety backups written before every import (a docker volume). */
  backupDir: env.BACKUP_DIR ?? '/data/backups',
  /** Where cached product images are stored (a docker volume). */
  imageDir: env.IMAGE_DIR ?? '/data/images',
  offUserAgent: env.OFF_USER_AGENT ?? 'Beepstock/0.1 (self-hosted home inventory)',
  /** After this many idle minutes the scan mode falls back to `defaultMode` (0 = never). */
  modeIdleMinutes: parseInt(env.MODE_IDLE_MINUTES ?? '0', 10),
  defaultMode: env.DEFAULT_MODE ?? 'consume',
  /** A pending best-before date / quantity expires after this many minutes without scans. */
  pendingMinutes: parseInt(env.PENDING_MINUTES ?? '10', 10),
};
