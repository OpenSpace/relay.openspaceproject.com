import fs from 'fs';
import path from 'path';
import { csvToSatelliteGP } from './csv';
import { gpToOMM } from './omm';
import { gpToTLE } from './tle';
import https from 'https';
import { Express, Request, Response } from 'express';
import config from '../../config.json';
import { notifySlack } from '../slack';

const CACHE_DIR = path.join(__dirname, '..', '..', 'cache', 'celestrak');

// Celestrak updates data every 6 hours; cache TTL matches that
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// Ensure cache directory exists
fs.mkdirSync(CACHE_DIR, { recursive: true });

function convertCsvToOMM(csv: string): string {
  const result: string[] = [];

  const satelliteGPs = csvToSatelliteGP(csv);
  for (const gp of satelliteGPs) {
    const s = gpToOMM(gp);
    result.push(s);
  }

  return result.join('\n') + '\n';
}

function convertCsvToTLE(csv: string): string {
  const result: string[] = [];

  const satelliteGPs = csvToSatelliteGP(csv);
  for (const gp of satelliteGPs) {
    try {
      const s = gpToTLE(gp);
      result.push(s);
    } catch (err) {
      // Objects with catalog numbers beyond the TLE-representable range are skipped
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[convert] Skipping ${gp.ObjectName} (${gp.NoradCatalogId}): ${message}`);
    }
  }

  return result.join('\n') + '\n';
}

// Map from a requested FORMAT (lowercased) to the CSV->target conversion function.
// For these formats the relay fetches Celestrak's CSV variant once and converts locally,
// so a single cached source serves every derived format. The native passthrough format
// 'csv' deliberately has no entry here.
const CSV_CONVERTERS: Readonly<Record<string, (csv: string) => string>> = {
  kvn: convertCsvToOMM,
  tle: convertCsvToTLE
};

// All FORMAT values the relay accepts. 'csv' is served verbatim from upstream; every
// other entry must have a corresponding converter in CSV_CONVERTERS.
const SUPPORTED_FORMATS: readonly string[] = ['csv', ...Object.keys(CSV_CONVERTERS)];

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

// Tracks upstream fetches that are currently in-progress, keyed by cache key.
// Concurrent requests for the same key share a single fetch Promise.
const inFlightRequests = new Map<string, Promise<UpstreamResponse>>();

// Tracks CSV->KVN/TLE conversions that are currently in-progress, keyed by the
// converted cache key. Concurrent requests asking for the same converted output share
// a single conversion Promise so the (potentially expensive) work runs only once.
const inFlightConversions = new Map<string, Promise<string>>();

// After an upstream failure, no new upstream request is made for the same key until the
// cooldown expires; stale cache (or 503) is served instead. This prevents hammering
// Celestrak with repeated failing requests, which extends their rate-limit blocks.
const FAILURE_COOLDOWN_MS = 5 * 60 * 1000;
const RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

// Per-key upstream failure timestamps: no upstream contact for a key until `until`
const upstreamFailures = new Map<string, { until: number }>();

function recordUpstreamFailure(key: string, cooldownMs: number): void {
  upstreamFailures.set(key, { until: Date.now() + cooldownMs });
}

// Global cap on simultaneous upstream connections to Celestrak, across all cache keys
const MAX_CONCURRENT_UPSTREAM = 2;
let activeUpstream = 0;
const upstreamQueue: (() => void)[] = [];

function acquireUpstreamSlot(): Promise<void> {
  return new Promise((resolve) => {
    if (activeUpstream < MAX_CONCURRENT_UPSTREAM) {
      activeUpstream++;
      resolve();
    } else {
      upstreamQueue.push(() => {
        activeUpstream++;
        resolve();
      });
    }
  });
}

function releaseUpstreamSlot(): void {
  activeUpstream--;
  const next = upstreamQueue.shift();
  if (next) next();
}

/**
 * Runs the given CSV->target-format conversion, deduplicating concurrent calls that
 * target the same converted cache key. The conversion is wrapped in a Promise so
 * multiple awaiters share the single result.
 */
function runConversion(
  convertedKey: string,
  csv: string,
  convertCsv: (csv: string) => string
): Promise<string> {
  let p = inFlightConversions.get(convertedKey);
  if (!p) {
    p = Promise.resolve()
      .then(() => convertCsv(csv))
      .finally(() => {
        inFlightConversions.delete(convertedKey);
      });
    inFlightConversions.set(convertedKey, p);
  }
  return p;
}

interface CacheMeta {
  fetchedAt: string;
}

/**
 * Returns the meta-file path for a given data-file key.
 */
function metaPath(key: string): string {
  return path.join(CACHE_DIR, key.replace(/\.txt$/, '.meta.json'));
}

/**
 * Reads all previously stored cache files from disk into the in-memory map. Each data
 * file (<key>.txt) must have a companion <key>.meta.json that records when the data was
 * fetched. Entries without a meta file are skipped. Called once at startup.
 */
function loadCacheFromDisk(): void {
  let loaded = 0;
  for (const file of fs.readdirSync(CACHE_DIR)) {
    if (!file.endsWith('.txt')) continue;
    const filePath = path.join(CACHE_DIR, file);
    const metaFilePath = metaPath(file);
    try {
      const metaRaw = fs.readFileSync(metaFilePath, 'utf8');
      const meta: CacheMeta = JSON.parse(metaRaw) as CacheMeta;
      const fetchedAt = new Date(meta.fetchedAt);
      if (isNaN(fetchedAt.getTime())) throw new Error('Invalid fetchedAt date');
      const body = fs.readFileSync(filePath, 'utf8');
      memCache.set(file, { body, mtime: fetchedAt });
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
 * Stores a new entry in the in-memory cache and persists both the data file and its
 * companion meta file to disk.
 */
function setCacheEntry(key: string, body: string, fetchedAt: Date = new Date()): void {
  memCache.set(key, { body, mtime: fetchedAt });
  const filePath = path.join(CACHE_DIR, key);
  const metaFilePath = metaPath(key);
  const meta: CacheMeta = { fetchedAt: fetchedAt.toISOString() };
  try {
    fs.writeFileSync(filePath, body, 'utf8');
    fs.writeFileSync(metaFilePath, JSON.stringify(meta), 'utf8');
    console.log(`[cache] STORED ${key}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[cache] Failed to write cache file: ${message}`);
  }
}

/**
 * Converts a query-parameter object into a deterministic, filesystem-safe cache key. Keys
 * are sorted so that ?A=1&B=2 and ?B=2&A=1 map to the same entry.
 */
function buildCacheKey(endpoint: string, params: Record<string, string>): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  // Replace characters that are unsafe in filenames; prefix with endpoint type
  return endpoint + '_' + sorted.replace(/[^a-zA-Z0-9=&._-]/g, '_') + '.txt';
}

/**
 * Fetches data from Celestrak and returns a Promise that resolves with `{ status, body }`
 * or rejects on network error.
 */
function fetchFromCelestrak(
  base: string,
  queryString: string
): Promise<UpstreamResponse> {
  return new Promise((resolve, reject) => {
    const url = `${base}?${queryString}`;

    const request = https.get(url, { timeout: 30_000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    request.on('error', reject);
    // destroy() aborts the request and closes the socket; the passed error is
    // delivered to the 'error' handler above, which rejects the promise
    request.on('timeout', () =>
      request.destroy(new Error('Upstream request timed out'))
    );
  });
}

/**
 * Factory that creates a relay handler for a given Celestrak endpoint.
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
 *
 * @param base     Full base URL of the Celestrak endpoint (gp or sup-gp).
 * @param endpoint Short identifier used as a cache-key prefix ('gp' or 'sup-gp').
 */
function makeCelestrakHandler(base: string, endpoint: string) {
  return async (req: Request, res: Response): Promise<void> => {
    // Reject requests where any query parameter appears more than once or is nested
    for (const [k, v] of Object.entries(req.query)) {
      if (typeof v !== 'string') {
        res.status(400).send(`Query parameter "${k}" must appear exactly once.`);
        return;
      }
    }
    const params = req.query as Record<string, string>;

    if (Object.keys(params).length === 0) {
      res
        .status(400)
        .send('Missing query parameters. Example: /celestrak?GROUP=starlink&FORMAT=csv');
      return;
    }

    // Only normalize when present: assigning `undefined` would add a FORMAT key that
    // URLSearchParams later stringifies to the literal "FORMAT=undefined" upstream
    if (params.FORMAT !== undefined) {
      params.FORMAT = params.FORMAT.toLowerCase();
    }

    if (params.FORMAT !== undefined && !SUPPORTED_FORMATS.includes(params.FORMAT)) {
      res
        .status(400)
        .send(
          `Unsupported FORMAT "${params.FORMAT}". Supported formats: ${SUPPORTED_FORMATS.join(', ').toUpperCase()}.`
        );
      return;
    }

    // Look up a converter for the requested FORMAT. A null result means the request is
    // either format-less or asks for the passthrough 'csv' format - in both cases we
    // serve the upstream body verbatim.
    const convertCsv: ((csv: string) => string) | null =
      params.FORMAT !== undefined && params.FORMAT !== 'csv'
        ? (CSV_CONVERTERS[params.FORMAT] ?? null)
        : null;
    const isConversionRequest = convertCsv !== null;
    const conversionLabel = isConversionRequest ? params.FORMAT!.toUpperCase() : '';

    const fetchParams = isConversionRequest ? { ...params, FORMAT: 'csv' } : params;
    const key = buildCacheKey(endpoint, fetchParams);
    const convertedKey = isConversionRequest ? buildCacheKey(endpoint, params) : '';

    // For conversion requests, serve from the converted cache directly if available
    const cachedConverted = isConversionRequest ? getMemCacheEntry(convertedKey) : null;
    if (isConversionRequest && cachedConverted) {
      if (cachedConverted.fresh || config['disable-upstream']) {
        console.log(`[cache] Serving cached ${conversionLabel} copy (${convertedKey})`);
        res.set('X-Cache', 'HIT');
        res.set('X-Cache-Date', cachedConverted.mtime.toUTCString());
        res.set('Content-Type', 'text/plain; charset=utf-8');
        res.send(cachedConverted.body);
        return;
      }
    }

    const cached = getMemCacheEntry(key);

    // Serve from fresh in-memory cache
    if (cached?.fresh || (cached && config['disable-upstream'])) {
      console.log(`[cache] Serving cached copy (${key})`);
      res.set('Content-Type', 'text/plain; charset=utf-8');
      if (isConversionRequest && convertCsv) {
        // If a converted copy exists and is at least as new as the CSV source, the
        // previously persisted result is still valid - serve it without reconverting
        // or re-writing to disk.
        if (
          cachedConverted &&
          cachedConverted.mtime.getTime() >= cached.mtime.getTime()
        ) {
          console.log(`[cache] Reusing stored ${conversionLabel} copy (${convertedKey})`);
          res.set('X-Cache', 'HIT');
          res.set('X-Cache-Date', cachedConverted.mtime.toUTCString());
          res.send(cachedConverted.body);
          return;
        }
        console.log(`[convert] CSV -> ${conversionLabel} conversion (${key})`);
        try {
          const convertedBody = await runConversion(
            convertedKey,
            cached.body,
            convertCsv
          );
          setCacheEntry(convertedKey, convertedBody, cached.mtime);
          res.set('X-Cache', 'HIT');
          res.set('X-Cache-Date', cached.mtime.toUTCString());
          res.send(convertedBody);
        } catch (convErr) {
          const convMsg = convErr instanceof Error ? convErr.message : String(convErr);
          console.error(`[convert] ${conversionLabel} conversion failed: ${convMsg}`);
          res.status(500).send(`${conversionLabel} conversion failed: ${convMsg}`);
        }
      } else {
        res.set('X-Cache', 'HIT');
        res.set('X-Cache-Date', cached.mtime.toUTCString());
        res.send(cached.body);
      }
      return;
    }

    // If this key recently failed upstream, don't contact Celestrak again until the
    // cooldown expires; serve stale data or 503 instead
    const failure = upstreamFailures.get(key);
    if (failure && Date.now() < failure.until) {
      const retryAfterSec = Math.ceil((failure.until - Date.now()) / 1000);
      console.warn(`[upstream] Cooldown active for ${retryAfterSec}s (${key})`);
      if (cached) {
        res.set('X-Cache', 'STALE');
        res.set('X-Cache-Date', cached.mtime.toUTCString());
        res.set('X-Cache-Reason', 'upstream-cooldown');
        res.set('Content-Type', 'text/plain; charset=utf-8');
        if (isConversionRequest && convertCsv) {
          console.log(`[convert] CSV -> ${conversionLabel} conversion (${key})`);
          try {
            res.send(await runConversion(convertedKey, cached.body, convertCsv));
          } catch (convErr) {
            const convMsg = convErr instanceof Error ? convErr.message : String(convErr);
            console.error(`[convert] ${conversionLabel} conversion failed: ${convMsg}`);
            res.status(500).send(`${conversionLabel} conversion failed: ${convMsg}`);
          }
        } else {
          res.send(cached.body);
        }
        return;
      }
      res.set('Retry-After', String(retryAfterSec));
      res
        .status(503)
        .send(
          'A recent upstream request for this data failed and no cached copy is ' +
            `available. Retry after ${retryAfterSec} seconds.`
        );
      return;
    }

    // Fetch from upstream, deduplicating concurrent requests for the same key
    const queryString = new URLSearchParams(fetchParams).toString();
    let upstream: UpstreamResponse;

    try {
      let fetchPromise = inFlightRequests.get(key);
      if (!fetchPromise) {
        fetchPromise = acquireUpstreamSlot()
          .then(() => fetchFromCelestrak(base, queryString).finally(releaseUpstreamSlot))
          .finally(() => {
            inFlightRequests.delete(key);
          });
        inFlightRequests.set(key, fetchPromise);
      }
      upstream = await fetchPromise;
    } catch (err) {
      recordUpstreamFailure(key, FAILURE_COOLDOWN_MS);
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[upstream] Network error: ${message}`);
      notifySlack(
        `network:${key}`,
        `:warning: Celestrak network error for \`${key}\`: ${message}`
      );
      if (cached) {
        console.warn(`[cache] Serving stale copy due to network error (${key})`);
        res.set('X-Cache', 'STALE');
        res.set('X-Cache-Date', cached.mtime.toUTCString());
        res.set('X-Cache-Reason', 'upstream-network-error');
        res.set('Content-Type', 'text/plain; charset=utf-8');
        if (isConversionRequest && convertCsv) {
          console.log(`[convert] CSV -> ${conversionLabel} conversion (${key})`);
          try {
            res.send(await runConversion(convertedKey, cached.body, convertCsv));
          } catch (convErr) {
            const convMsg = convErr instanceof Error ? convErr.message : String(convErr);
            console.error(`[convert] ${conversionLabel} conversion failed: ${convMsg}`);
            res.status(500).send(`${conversionLabel} conversion failed: ${convMsg}`);
          }
        } else {
          res.send(cached.body);
        }
        return;
      }
      res.status(502).send(`Upstream request failed: ${message}`);
      return;
    }

    // Handle 403 rate-limit response
    if (upstream.status === 403) {
      recordUpstreamFailure(key, RATE_LIMIT_COOLDOWN_MS);
      console.warn(`[upstream] 403 received for ${key}`);
      console.warn(`[upstream] Body: ${upstream.body.trim()}`);
      notifySlack(
        `403:${key}`,
        `:no_entry: Celestrak rate-limited (403) request \`${key}\`:\n${upstream.body.trim()}`
      );
      if (cached) {
        console.log(`[cache] Serving stale copy after 403 (${key})`);
        res.set('X-Cache', 'STALE');
        res.set('X-Cache-Date', cached.mtime.toUTCString());
        res.set('X-Cache-Reason', 'upstream-rate-limited');
        res.set('Content-Type', 'text/plain; charset=utf-8');
        if (isConversionRequest && convertCsv) {
          console.log(`[convert] CSV -> ${conversionLabel} conversion (${key})`);
          try {
            res.send(await runConversion(convertedKey, cached.body, convertCsv));
          } catch (convErr) {
            const convMsg = convErr instanceof Error ? convErr.message : String(convErr);
            console.error(`[convert] ${conversionLabel} conversion failed: ${convMsg}`);
            res.status(500).send(`${conversionLabel} conversion failed: ${convMsg}`);
          }
        } else {
          res.send(cached.body);
        }
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

    // Handle non-200 upstream responses
    if (upstream.status !== 200) {
      recordUpstreamFailure(key, FAILURE_COOLDOWN_MS);
      console.error(`[upstream] Unexpected status ${upstream.status} for ${key}`);
      notifySlack(
        `status-${upstream.status}:${key}`,
        `:warning: Celestrak returned HTTP ${upstream.status} for \`${key}\`:\n${upstream.body.trim()}`
      );
      if (cached) {
        res.set('X-Cache', 'STALE');
        res.set('X-Cache-Date', cached.mtime.toUTCString());
        res.set('X-Cache-Reason', `upstream-${upstream.status}`);
        res.set('Content-Type', 'text/plain; charset=utf-8');
        if (isConversionRequest && convertCsv) {
          console.log(`[convert] CSV -> ${conversionLabel} conversion (${key})`);
          try {
            res.send(await runConversion(convertedKey, cached.body, convertCsv));
          } catch (convErr) {
            const convMsg = convErr instanceof Error ? convErr.message : String(convErr);
            console.error(`[convert] ${conversionLabel} conversion failed: ${convMsg}`);
            res.status(500).send(`${conversionLabel} conversion failed: ${convMsg}`);
          }
        } else {
          res.send(cached.body);
        }
        return;
      }
      res
        .status(502)
        .send(`Upstream returned HTTP ${upstream.status}:\n${upstream.body}`);
      return;
    }

    // 200 OK: update in-memory cache, persist to disk, and respond
    upstreamFailures.delete(key);
    const fetchedAt = new Date();
    setCacheEntry(key, upstream.body, fetchedAt);

    res.set('X-Cache', 'MISS');
    res.set('Content-Type', 'text/plain; charset=utf-8');
    if (isConversionRequest && convertCsv) {
      console.log(`[convert] CSV -> ${conversionLabel} conversion (${key})`);
      try {
        const convertedBody = await runConversion(
          convertedKey,
          upstream.body,
          convertCsv
        );
        setCacheEntry(convertedKey, convertedBody, fetchedAt);
        res.send(convertedBody);
      } catch (convErr) {
        const convMsg = convErr instanceof Error ? convErr.message : String(convErr);
        console.error(`[convert] ${conversionLabel} conversion failed: ${convMsg}`);
        res.status(500).send(`${conversionLabel} conversion failed: ${convMsg}`);
      }
    } else {
      res.send(upstream.body);
    }
  };
}

export function initialize() {
  loadCacheFromDisk();
}

export function registerHandlers(app: Express) {
  const CELESTRAK_GP_BASE = 'https://celestrak.org/NORAD/elements/gp.php';
  const CELESTRAK_SUP_GP_BASE =
    'https://celestrak.org/NORAD/elements/supplemental/sup-gp.php';

  // /celestrak        -> gp.php      (general perturbations)
  app.get('/celestrak', makeCelestrakHandler(CELESTRAK_GP_BASE, 'gp'));
  // /celestrak/sup-gp -> sup-gp.php  (supplemental GP, higher-cadence updates)
  app.get('/celestrak/sup-gp', makeCelestrakHandler(CELESTRAK_SUP_GP_BASE, 'sup-gp'));
}
