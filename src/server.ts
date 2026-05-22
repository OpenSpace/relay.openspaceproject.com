import express, { Request, Response } from 'express';
import https from 'https';
import fs from 'fs';
import path from 'path';
import config from '../config.json';

const app = express();
const PORT = config.port;
const CACHE_DIR = path.join(__dirname, '..', 'cache', 'celestrak');
const CELESTRAK_GP_BASE = 'https://celestrak.org/NORAD/elements/gp.php';
const CELESTRAK_SUP_GP_BASE =
  'https://celestrak.org/NORAD/elements/supplemental/sup-gp.php';

// Celestrak updates data every 6 hours; cache TTL matches that
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

// Ensure cache directory exists
fs.mkdirSync(CACHE_DIR, { recursive: true });

interface SatelliteGP {
  ObjectName: string;
  ObjectId: string;
  Epoch: string;
  MeanMotion: number;
  Eccentricity: number;
  Inclination: number;
  RaAscNode: number;
  ArgOfPericenter: number;
  MeanAnomaly: number;
  EphemerisType: number;
  ClassificationType: string;
  NoradCatalogId: number;
  ElementSetNumber: number;
  RevAtEpoch: number;
  BStar: number;
  MeanMotionDot: number;
  MeanMotionDdot: number;
}

/**
 * Splits a single CSV line into fields following RFC 4180:
 * - Fields may be enclosed in double-quotes.
 * - A double-quote inside a quoted field is escaped as "".
 * - Commas inside quoted fields are treated as field content, not separators.
 */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;

  while (i < line.length) {
    if (line[i] === '"') {
      let field = '';
      i++; // skip opening quote
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            i++; // skip closing quote
            break;
          }
        } else {
          field += line[i++];
        }
      }
      fields.push(field);
      if (i < line.length && line[i] === ',') i++;
    } else {
      const start = i;
      while (i < line.length && line[i] !== ',') i++;
      fields.push(line.substring(start, i));
      if (i < line.length) i++; // skip comma
    }
  }

  return fields;
}

function parseSatelliteGPLine(
  headerIndex: Record<string, number>,
  line: string
): SatelliteGP {
  const values = splitCsvLine(line);

  const get = (field: string): string => {
    const index = headerIndex[field];
    if (index === undefined) throw new Error(`Missing field: ${field}`);
    if (index < 0 || index >= values.length || values[index] === undefined) {
      throw new Error(`Missing value for field: ${field}`);
    }
    const raw = values[index];
    return raw.trim();
  };

  const num = (field: string): number => {
    const raw = get(field);
    const value = Number(raw);
    if (isNaN(value)) throw new Error(`Invalid number for field ${field}: ${raw}`);
    return value;
  };

  return {
    ObjectName: get('OBJECT_NAME'),
    ObjectId: get('OBJECT_ID'),
    Epoch: get('EPOCH'),
    MeanMotion: num('MEAN_MOTION'),
    Eccentricity: num('ECCENTRICITY'),
    Inclination: num('INCLINATION'),
    RaAscNode: num('RA_OF_ASC_NODE'),
    ArgOfPericenter: num('ARG_OF_PERICENTER'),
    MeanAnomaly: num('MEAN_ANOMALY'),
    EphemerisType: num('EPHEMERIS_TYPE'),
    ClassificationType: get('CLASSIFICATION_TYPE'),
    NoradCatalogId: num('NORAD_CAT_ID'),
    ElementSetNumber: num('ELEMENT_SET_NO'),
    RevAtEpoch: num('REV_AT_EPOCH'),
    BStar: num('BSTAR'),
    MeanMotionDot: num('MEAN_MOTION_DOT'),
    MeanMotionDdot: num('MEAN_MOTION_DDOT')
  };
}

function csvToSatelliteGP(csv: string): SatelliteGP[] {
  const lines = csv.split('\n');
  if (lines.length <= 1) {
    const firstLinePreview = (lines[0] ?? '').slice(0, 200);
    console.log(
      `[convert] Error converting csv: size=${csv.length} chars, lines=${lines.length}, firstLinePreview="${firstLinePreview}"`
    );
    return [];
  }

  const headerIndex: Record<string, number> = {};
  splitCsvLine(lines[0].trimEnd()).forEach((key, i) => {
    headerIndex[key] = i;
  });
  lines.shift();

  const gpData: SatelliteGP[] = [];
  lines.forEach((element) => {
    if (element.trim() === '') {
      return;
    }

    const gp = parseSatelliteGPLine(headerIndex, element);
    gpData.push(gp);
  });

  return gpData;
}

function gpToOMM(gp: SatelliteGP): string {
  // Leaving the CREATION_DATE and ORIGINATOR field empty for compatibility with the
  // Celestrak result

  return `CCSDS_OMM_VERS = 2.0
CREATION_DATE  = 
ORIGINATOR     = 

OBJECT_NAME    = ${gp.ObjectName}
OBJECT_ID      = ${gp.ObjectId}
CENTER_NAME    = EARTH
REF_FRAME      = TEME
TIME_SYSTEM    = UTC
MEAN_ELEMENT_THEORY = SGP/SGP4

EPOCH          = ${gp.Epoch}
MEAN_MOTION    = ${gp.MeanMotion}
ECCENTRICITY   = ${gp.Eccentricity}
INCLINATION    = ${gp.Inclination}
RA_OF_ASC_NODE = ${gp.RaAscNode}
ARG_OF_PERICENTER = ${gp.ArgOfPericenter}
MEAN_ANOMALY   = ${gp.MeanAnomaly}

EPHEMERIS_TYPE = ${gp.EphemerisType}
CLASSIFICATION_TYPE = ${gp.ClassificationType}
NORAD_CAT_ID   = ${gp.NoradCatalogId}
ELEMENT_SET_NO = ${gp.ElementSetNumber}
REV_AT_EPOCH   = ${gp.RevAtEpoch}
BSTAR          = ${gp.BStar}
MEAN_MOTION_DOT = ${gp.MeanMotionDot}
MEAN_MOTION_DDOT = ${gp.MeanMotionDdot}
`;
}

function convertCsvToOMM(csv: string): string {
  const result: string[] = [];

  const satelliteGPs = csvToSatelliteGP(csv);
  for (const gp of satelliteGPs) {
    const s = gpToOMM(gp);
    result.push(s);
  }

  return result.join('\n');
}

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

    https
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

    params.FORMAT = params.FORMAT?.toLowerCase();

    const SUPPORTED_FORMATS = ['kvn', 'tle', 'csv'];
    if (params.FORMAT !== undefined && !SUPPORTED_FORMATS.includes(params.FORMAT)) {
      res.status(400).send(
        `Unsupported FORMAT "${params.FORMAT}". Supported formats: ${SUPPORTED_FORMATS.join(', ').toUpperCase()}.`
      );
      return;
    }

    // When the caller requests OMM KVN format, fetch the CSV version instead
    // and convert locally so that a single cached copy serves both variants.
    const isOMMRequest = params.FORMAT === 'kvn';
    const fetchParams = isOMMRequest ? { ...params, FORMAT: 'csv' } : params;
    const key = buildCacheKey(endpoint, fetchParams);
    const ommKey = isOMMRequest ? buildCacheKey(endpoint, params) : '';

    // For OMM requests, serve from the OMM cache directly if available
    if (isOMMRequest) {
      const cachedOMM = getMemCacheEntry(ommKey);
      if (cachedOMM?.fresh || (cachedOMM && config['disable-upstream'])) {
        console.log(`[cache] Serving cached OMM copy (${ommKey})`);
        res.set('X-Cache', 'HIT');
        res.set('X-Cache-Date', cachedOMM.mtime.toUTCString());
        res.set('Content-Type', 'text/plain; charset=utf-8');
        res.send(cachedOMM.body);
        return;
      }
    }

    const cached = getMemCacheEntry(key);

    // Serve from fresh in-memory cache
    if (cached?.fresh || (cached && config['disable-upstream'])) {
      console.log(`[cache] Serving cached copy (${key})`);
      res.set('Content-Type', 'text/plain; charset=utf-8');
      if (isOMMRequest) {
        console.log(`[convert] CSV -> OMM conversion (${key})`);
        try {
          const ommBody = convertCsvToOMM(cached.body);
          setCacheEntry(ommKey, ommBody, cached.mtime);
          res.set('X-Cache', 'HIT');
          res.set('X-Cache-Date', cached.mtime.toUTCString());
          res.send(ommBody);
        } catch (convErr) {
          const convMsg = convErr instanceof Error ? convErr.message : String(convErr);
          console.error(`[convert] OMM conversion failed: ${convMsg}`);
          res.status(500).send(`OMM conversion failed: ${convMsg}`);
        }
      } else {
        res.set('X-Cache', 'HIT');
        res.set('X-Cache-Date', cached.mtime.toUTCString());
        res.send(cached.body);
      }
      return;
    }

    // Fetch from upstream, deduplicating concurrent requests for the same key
    const queryString = new URLSearchParams(fetchParams).toString();
    let upstream: UpstreamResponse;

    try {
      let fetchPromise = inFlightRequests.get(key);
      if (!fetchPromise) {
        fetchPromise = fetchFromCelestrak(base, queryString).finally(() => {
          inFlightRequests.delete(key);
        });
        inFlightRequests.set(key, fetchPromise);
      }
      upstream = await fetchPromise;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[upstream] Network error: ${message}`);
      if (cached) {
        console.warn(`[cache] Serving stale copy due to network error (${key})`);
        res.set('X-Cache', 'STALE');
        res.set('X-Cache-Date', cached.mtime.toUTCString());
        res.set('X-Cache-Reason', 'upstream-network-error');
        res.set('Content-Type', 'text/plain; charset=utf-8');
        if (isOMMRequest) {
          console.log(`[convert] CSV -> OMM conversion (${key})`);
          try {
            res.send(convertCsvToOMM(cached.body));
          } catch (convErr) {
            const convMsg = convErr instanceof Error ? convErr.message : String(convErr);
            console.error(`[convert] OMM conversion failed: ${convMsg}`);
            res.status(500).send(`OMM conversion failed: ${convMsg}`);
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
      console.warn(`[upstream] 403 received for ${key}`);
      console.warn(`[upstream] Body: ${upstream.body.trim()}`);
      if (cached) {
        console.log(`[cache] Serving stale copy after 403 (${key})`);
        res.set('X-Cache', 'STALE');
        res.set('X-Cache-Date', cached.mtime.toUTCString());
        res.set('X-Cache-Reason', 'upstream-rate-limited');
        res.set('Content-Type', 'text/plain; charset=utf-8');
        if (isOMMRequest) {
          console.log(`[convert] CSV -> OMM conversion (${key})`);
          try {
            res.send(convertCsvToOMM(cached.body));
          } catch (convErr) {
            const convMsg = convErr instanceof Error ? convErr.message : String(convErr);
            console.error(`[convert] OMM conversion failed: ${convMsg}`);
            res.status(500).send(`OMM conversion failed: ${convMsg}`);
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
      console.error(`[upstream] Unexpected status ${upstream.status} for ${key}`);
      if (cached) {
        res.set('X-Cache', 'STALE');
        res.set('X-Cache-Date', cached.mtime.toUTCString());
        res.set('X-Cache-Reason', `upstream-${upstream.status}`);
        res.set('Content-Type', 'text/plain; charset=utf-8');
        if (isOMMRequest) {
          console.log(`[convert] CSV -> OMM conversion (${key})`);
          try {
            res.send(convertCsvToOMM(cached.body));
          } catch (convErr) {
            const convMsg = convErr instanceof Error ? convErr.message : String(convErr);
            console.error(`[convert] OMM conversion failed: ${convMsg}`);
            res.status(500).send(`OMM conversion failed: ${convMsg}`);
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
    const fetchedAt = new Date();
    setCacheEntry(key, upstream.body, fetchedAt);

    res.set('X-Cache', 'MISS');
    res.set('Content-Type', 'text/plain; charset=utf-8');
    if (isOMMRequest) {
      console.log(`[convert] CSV -> OMM conversion (${key})`);
      try {
        const ommBody = convertCsvToOMM(upstream.body);
        setCacheEntry(ommKey, ommBody, fetchedAt);
        res.send(ommBody);
      } catch (convErr) {
        const convMsg = convErr instanceof Error ? convErr.message : String(convErr);
        console.error(`[convert] OMM conversion failed: ${convMsg}`);
        res.status(500).send(`OMM conversion failed: ${convMsg}`);
      }
    } else {
      res.send(upstream.body);
    }
  };
}

//
// main()
//

// /celestrak        -> gp.php      (general perturbations)
app.get('/celestrak', makeCelestrakHandler(CELESTRAK_GP_BASE, 'gp'));
// /celestrak/sup-gp -> sup-gp.php  (supplemental GP, higher-cadence updates)
app.get('/celestrak/sup-gp', makeCelestrakHandler(CELESTRAK_SUP_GP_BASE, 'sup-gp'));

loadCacheFromDisk();

app.listen(PORT, () => {
  console.log(`Celestrak relay listening on http://localhost:${PORT}`);
  console.log(`Cache directory: ${CACHE_DIR}`);
  console.log(`Cache TTL: ${CACHE_TTL_MS / 60_000} minutes`);
});
