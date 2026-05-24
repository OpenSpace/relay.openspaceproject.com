import { describe, it, expect } from 'vitest';
import https from 'https';
import { csvToSatelliteGP } from '../src/celestrak/csv';
import { gpToOMM } from '../src/celestrak/omm';
import { gpToTLE } from '../src/celestrak/tle';

/**
 * Fetches data from a Celestrak endpoint with the given query parameters.
 */
function fetchCelestrak(
  params: Record<string, string>,
  base = 'https://celestrak.org/NORAD/elements/gp.php'
): Promise<string> {
  const query = new URLSearchParams(params).toString();
  const url = `${base}?${query}`;

  return new Promise((resolve, reject) => {
    https
      .get(url, { timeout: 30_000 }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Celestrak returned HTTP ${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      })
      .on('error', reject)
      .on('timeout', () => reject(new Error('Request timed out')));
  });
}

function convertCsvToOMM(csv: string): string {
  const gps = csvToSatelliteGP(csv);
  return gps.map(gpToOMM).join('\n') + '\n';
}

function convertCsvToTLE(csv: string): string {
  const gps = csvToSatelliteGP(csv);
  return gps.map(gpToTLE).join('\n') + '\n';
}

/**
 * Normalizes line endings to \n for comparison purposes.
 * Celestrak responds with \r\n but our local converters emit \n.
 */
function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n/g, '\n');
}

/**
 * Compares two output strings line-by-line, tolerating ±1 in the last digit of any
 * numeric token. This accounts for IEEE-754 rounding differences when converting
 * Fortran-style scientific notation through JavaScript's Number type.
 *
 * Returns an object with `pass` and, on failure, `message` describing the first mismatch.
 */
function compareWithTolerance(
  actual: string,
  expected: string
): { pass: boolean; message?: string } {
  const actualLines = actual.split('\n');
  const expectedLines = expected.split('\n');

  if (actualLines.length !== expectedLines.length) {
    return {
      pass: false,
      message: `Line count differs: got ${actualLines.length}, expected ${expectedLines.length}`
    };
  }

  for (let i = 0; i < actualLines.length; i++) {
    if (actualLines[i] === expectedLines[i]) continue;

    // Check if lines differ only in the last digit of numeric tokens
    if (!linesMatchWithTolerance(actualLines[i], expectedLines[i])) {
      return {
        pass: false,
        message: `Line ${i + 1} differs beyond tolerance:\n  got:      "${actualLines[i]}"\n  expected: "${expectedLines[i]}"`
      };
    }
  }

  return { pass: true };
}

/**
 * Returns true if two lines are identical except for ±1 differences in the last digit
 * of numeric tokens (integers or decimals). For TLE data lines (starting with "1 " or
 * "2 " and exactly 69 chars), the trailing checksum character is excluded from comparison
 * since a single-ULP numeric change can cause multi-digit checksum differences.
 */
function linesMatchWithTolerance(a: string, b: string): boolean {
  let lineA = a;
  let lineB = b;

  // Strip TLE checksum (last char) if both lines look like TLE data lines
  const isTleLine = (l: string) =>
    l.length === 69 && (l.startsWith('1 ') || l.startsWith('2 '));
  if (isTleLine(lineA) && isTleLine(lineB)) {
    lineA = lineA.slice(0, -1);
    lineB = lineB.slice(0, -1);
  }
  // Tokenize by splitting on boundaries between numeric and non-numeric characters,
  // preserving structure. The pattern matches numbers (including those starting with '.')
  // then non-whitespace, then whitespace.
  const tokenPattern = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?|\S+|\s+/g;
  const tokensA = lineA.match(tokenPattern) ?? [];
  const tokensB = lineB.match(tokenPattern) ?? [];

  if (tokensA.length !== tokensB.length) return false;

  for (let i = 0; i < tokensA.length; i++) {
    if (tokensA[i] === tokensB[i]) continue;

    // Both must be numeric for tolerance to apply
    const numA = Number(tokensA[i]);
    const numB = Number(tokensB[i]);
    if (isNaN(numA) || isNaN(numB)) return false;

    // Determine the magnitude of 1 ULP in the last printed digit.
    // Use the expected token's string to figure out decimal places.
    const decMatch = tokensB[i].match(/\.(\d+)/);
    const decimals = decMatch ? decMatch[1].length : 0;
    const ulp = Math.pow(10, -decimals);

    if (Math.abs(numA - numB) > ulp * 1.001) return false;
  }

  return true;
}

expect.extend({
  toMatchWithFloatTolerance(received: string, expected: string) {
    const result = compareWithTolerance(received, expected);
    return {
      pass: result.pass,
      message: () => result.message ?? '',
      actual: received,
      expected
    };
  }
});

declare module 'vitest' {
  interface Assertion {
    toMatchWithFloatTolerance(expected: string): void;
  }
}

// Test groups to verify against. Each entry fetches CSV from Celestrak, converts locally,
// and compares against Celestrak's own TLE/KVN output for the same query.
const TEST_GROUPS = ['galileo', 'geo', 'last-30-days', 'visual'] as const;

describe.each(TEST_GROUPS)('CSV conversion for GROUP=%s', (group) => {
  let csvData: string;
  let celestrakTLE: string;
  let celestrakOMM: string;

  // Fetch all three formats from Celestrak before running assertions.
  // Using a generous timeout since Celestrak may rate-limit.
  it('fetches data from Celestrak', async () => {
    [csvData, celestrakTLE, celestrakOMM] = await Promise.all([
      fetchCelestrak({ GROUP: group, FORMAT: 'csv' }),
      fetchCelestrak({ GROUP: group, FORMAT: 'tle' }),
      fetchCelestrak({ GROUP: group, FORMAT: 'kvn' })
    ]);

    expect(csvData.length).toBeGreaterThan(0);
    expect(celestrakTLE.length).toBeGreaterThan(0);
    expect(celestrakOMM.length).toBeGreaterThan(0);
  }, 60_000);

  it('CSV -> TLE matches Celestrak TLE output', () => {
    const localTLE = convertCsvToTLE(csvData);
    expect(localTLE).toMatchWithFloatTolerance(normalizeLineEndings(celestrakTLE));
  });

  it('CSV -> OMM (KVN) matches Celestrak KVN output', () => {
    const localOMM = convertCsvToOMM(csvData);
    expect(localOMM).toMatchWithFloatTolerance(normalizeLineEndings(celestrakOMM));
  });
});

// Single-satellite test using CATNR to verify an individual record round-trips correctly.
const TEST_CATNRS = ['25544', '62891'] as const;

describe.each(TEST_CATNRS)('CSV conversion for CATNR=%s', (catnr) => {
  let csvData: string;
  let celestrakTLE: string;
  let celestrakOMM: string;

  it('fetches data from Celestrak', async () => {
    [csvData, celestrakTLE, celestrakOMM] = await Promise.all([
      fetchCelestrak({ CATNR: catnr, FORMAT: 'csv' }),
      fetchCelestrak({ CATNR: catnr, FORMAT: 'tle' }),
      fetchCelestrak({ CATNR: catnr, FORMAT: 'kvn' })
    ]);

    expect(csvData.length).toBeGreaterThan(0);
    expect(celestrakTLE.length).toBeGreaterThan(0);
    expect(celestrakOMM.length).toBeGreaterThan(0);
  }, 60_000);

  it('CSV -> TLE matches Celestrak TLE output', () => {
    const localTLE = convertCsvToTLE(csvData);
    expect(localTLE).toMatchWithFloatTolerance(normalizeLineEndings(celestrakTLE));
  });

  it('CSV -> OMM (KVN) matches Celestrak KVN output', () => {
    const localOMM = convertCsvToOMM(csvData);
    expect(localOMM).toMatchWithFloatTolerance(normalizeLineEndings(celestrakOMM));
  });
});

// Supplemental GP endpoint tests
const SUP_GP_BASE = 'https://celestrak.org/NORAD/elements/supplemental/sup-gp.php';
const SUP_GP_FILES = ['kuiper'] as const;

describe.each(SUP_GP_FILES)('Supplemental CSV conversion for FILE=%s', (file) => {
  let csvData: string;
  let celestrakTLE: string;
  let celestrakOMM: string;

  it('fetches data from Celestrak supplemental endpoint', async () => {
    [csvData, celestrakTLE, celestrakOMM] = await Promise.all([
      fetchCelestrak({ FILE: file, FORMAT: 'csv' }, SUP_GP_BASE),
      fetchCelestrak({ FILE: file, FORMAT: 'tle' }, SUP_GP_BASE),
      fetchCelestrak({ FILE: file, FORMAT: 'kvn' }, SUP_GP_BASE)
    ]);

    expect(csvData.length).toBeGreaterThan(0);
    expect(celestrakTLE.length).toBeGreaterThan(0);
    expect(celestrakOMM.length).toBeGreaterThan(0);
  }, 60_000);

  it('CSV -> TLE matches Celestrak TLE output', () => {
    const localTLE = convertCsvToTLE(csvData);
    expect(localTLE).toMatchWithFloatTolerance(normalizeLineEndings(celestrakTLE));
  });

  it('CSV -> OMM (KVN) matches Celestrak KVN output', () => {
    const localOMM = convertCsvToOMM(csvData);
    expect(localOMM).toMatchWithFloatTolerance(normalizeLineEndings(celestrakOMM));
  });
});
