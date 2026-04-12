import express, { Request, Response } from 'express';
import http from 'http';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = 3000;
const CACHE_DIR = path.join(__dirname, '..', 'cache');
const CELESTRAK_BASE = 'http://www.celestrak.org/NORAD/elements/gp.php';

// Celestrak updates data every 2 hours; cache TTL matches that
const CACHE_TTL_MS = 2 * 60 * 60 * 1000;

// Ensure cache directory exists
fs.mkdirSync(CACHE_DIR, { recursive: true });

interface MemCacheEntry {
  body: string;
  mtime: Date;
}

interface CacheEntry extends MemCacheEntry {
  fresh: boolean;
}

interface UpstreamResponse {
  status: number;
  body: string;
}

// In-memory cache: key is the cache filename (normalized query string)
const memCache = new Map<string, MemCacheEntry>();

/**
 * Reads all previously stored cache files from disk into the in-memory map.
 * Called once at startup.
 */
function loadCacheFromDisk(): void {
  let loaded = 0;
  for (const file of fs.readdirSync(CACHE_DIR)) {
    if (!file.endsWith('.txt')) continue;
    const filePath = path.join(CACHE_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      const body = fs.readFileSync(filePath, 'utf8');
      memCache.set(file, { body, mtime: stat.mtime });
      loaded++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[cache] Could not load ${file}: ${message}`);
    }
  }
  console.log(`[cache] Loaded ${loaded} entries from disk`);
}

/**
 * Returns the in-memory cache entry for the given key, or null if absent.
 */
function getMemCacheEntry(key: string): CacheEntry | null {
  const entry = memCache.get(key);
  if (!entry) return null;
  const age = Date.now() - entry.mtime.getTime();
  return { ...entry, fresh: age < CACHE_TTL_MS };
}

/**
 * Stores a new entry in the in-memory cache and persists it to disk.
 */
function setCacheEntry(key: string, body: string): void {
  const mtime = new Date();
  memCache.set(key, { body, mtime });
  const filePath = path.join(CACHE_DIR, key);
  try {
    fs.writeFileSync(filePath, body, 'utf8');
    console.log(`[cache] STORED ${key}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cache] Failed to write cache file: ${message}`);
  }
}

/**
 * Converts a query-parameter object into a deterministic, filesystem-safe cache key.
 * Keys are sorted so that ?A=1&B=2 and ?B=2&A=1 map to the same entry.
 */
function buildCacheKey(params: Record<string, string>): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  // Replace characters that are unsafe in filenames
  return sorted.replace(/[^a-zA-Z0-9=&._-]/g, '_') + '.txt';
}

/**
 * Fetches data from Celestrak and returns a Promise that resolves with
 * { status, body } or rejects on network error.
 */
function fetchFromCelestrak(queryString: string): Promise<UpstreamResponse> {
  return new Promise((resolve, reject) => {
    const url = `${CELESTRAK_BASE}?${queryString}`;

    http
      .get(url, { timeout: 30_000 }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, body });
        });
      })
      .on('error', reject)
      .on('timeout', () => reject(new Error('Upstream request timed out')));
  });
}

/**
 * Main relay handler.
 *
 * Accepted query params (passed through verbatim to Celestrak):
 *   GROUP=<name>&FORMAT=<fmt>
 *   CATNR=<id>&FORMAT=<fmt>
 *   ... and any other valid Celestrak GP parameters.
 *
 * Cache behavior:
 *   1. Fresh cache hit -> serve from in-memory cache immediately.
 *   2. No cache / stale -> fetch upstream.
 *        a. 200 OK           -> update memory + disk, serve new data.
 *        b. 403 (rate-limit) -> serve stale in-memory copy if available, else 503.
 *        c. Other error      -> 502 with upstream status forwarded.
 */
app.get('/', async (req: Request, res: Response) => {
  const params = req.query as Record<string, string>;

  if (!params || Object.keys(params).length === 0) {
    res
      .status(400)
      .send('Missing query parameters. Example: /?GROUP=starlink&FORMAT=kvn');
    return;
  }

  const key = buildCacheKey(params);
  const cached = getMemCacheEntry(key);

  // --- Serve from fresh in-memory cache ---
  if (cached?.fresh) {
    console.log(`[cache] Serving cached copy (${key})`);
    res.set('X-Cache', 'HIT');
    res.set('X-Cache-Date', cached.mtime.toUTCString());
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(cached.body);
    return;
  }

  // --- Fetch from upstream ---
  const queryString = new URLSearchParams(params).toString();
  let upstream: UpstreamResponse;

  try {
    upstream = await fetchFromCelestrak(queryString);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[upstream] Network error: ${message}`);
    if (cached) {
      console.warn(`[cache] Serving stale copy due to network error (${key})`);
      res.set('X-Cache', 'STALE');
      res.set('X-Cache-Date', cached.mtime.toUTCString());
      res.set('X-Cache-Reason', 'upstream-network-error');
      res.set('Content-Type', 'text/plain; charset=utf-8');
      res.send(cached.body);
      return;
    }
    res.status(502).send(`Upstream request failed: ${message}`);
    return;
  }

  // --- Handle 403 rate-limit response ---
  if (upstream.status === 403) {
    console.warn(`[upstream] 403 received for ${key}`);
    console.warn(`[upstream] Body: ${upstream.body.trim()}`);
    if (cached) {
      console.log(`[cache] Serving stale copy after 403 (${key})`);
      res.set('X-Cache', 'STALE');
      res.set('X-Cache-Date', cached.mtime.toUTCString());
      res.set('X-Cache-Reason', 'upstream-rate-limited');
      res.set('Content-Type', 'text/plain; charset=utf-8');
      res.send(cached.body);
      return;
    }
    res
      .status(503)
      .send(
        `Celestrak is rate-limiting this request and no cached copy is available.\n\n` +
          `Upstream message:\n${upstream.body}`
      );
    return;
  }

  // --- Handle non-200 upstream responses ---
  if (upstream.status !== 200) {
    console.error(`[upstream] Unexpected status ${upstream.status} for ${key}`);
    if (cached) {
      res.set('X-Cache', 'STALE');
      res.set('X-Cache-Date', cached.mtime.toUTCString());
      res.set('X-Cache-Reason', `upstream-${upstream.status}`);
      res.set('Content-Type', 'text/plain; charset=utf-8');
      res.send(cached.body);
      return;
    }
    res.status(502).send(`Upstream returned HTTP ${upstream.status}:\n${upstream.body}`);
    return;
  }

  // --- 200 OK: update in-memory cache, persist to disk, and respond ---
  setCacheEntry(key, upstream.body);

  res.set('X-Cache', 'MISS');
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.send(upstream.body);
});

loadCacheFromDisk();

app.listen(PORT, () => {
  console.log(`Celestrak relay listening on http://localhost:${PORT}`);
  console.log(`Cache directory: ${CACHE_DIR}`);
  console.log(`Cache TTL: ${CACHE_TTL_MS / 60_000} minutes`);
});
