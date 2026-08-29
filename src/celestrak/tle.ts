import { SatelliteGP } from './gp';

// Assumed-decimal exponential format: "[ -]NNNNN[+-]N" (8 chars), e.g. " 12345-4"
// represents 0.12345e-4
function formatExp(v: number): string {
  if (v === 0) return ' 00000+0';
  const sign = v < 0 ? '-' : ' ';
  const abs = Math.abs(v);
  let exp = Math.floor(Math.log10(abs)) + 1;
  const mantissa = abs / Math.pow(10, exp);
  let mantStr = Math.round(mantissa * 100_000).toString();
  if (mantStr.length > 5) {
    // Rounding bumped 0.99999... up to 1.0; renormalize
    exp += 1;
    mantStr = '10000';
  }
  mantStr = mantStr.padStart(5, '0');
  const expSign = exp < 0 ? '-' : '+';
  return sign + mantStr + expSign + Math.abs(exp).toString();
}

// Signed decimal-fraction field, no leading zero before the point: "[ -].NNNNNNNN"
function formatFirstDeriv(v: number): string {
  const sign = v < 0 ? '-' : ' ';
  return sign + Math.abs(v).toFixed(8).slice(1);
}

function checksum(line: string): string {
  let sum = 0;
  for (const ch of line) {
    if (ch >= '0' && ch <= '9') sum += ch.charCodeAt(0) - 48;
    else if (ch === '-') sum += 1;
  }
  return (sum % 10).toString();
}

// Alpha-5 letters for the leading two digits (10-33); I and O are excluded to avoid
// confusion with 1 and 0
const ALPHA5_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * Formats a NORAD catalog number as the 5-character TLE field. Numbers up to 99999 are
 * zero-padded digits; 100000-339999 use the Alpha-5 scheme (leading letter encodes the
 * first two digits). Larger numbers cannot be represented in TLE format.
 */
export function formatCatalogNumber(id: number): string {
  if (id <= 99_999) return id.toString().padStart(5, '0');
  if (id <= 339_999) {
    const letter = ALPHA5_LETTERS[Math.floor(id / 10_000) - 10];
    return letter + (id % 10_000).toString().padStart(4, '0');
  }
  throw new Error(`NORAD catalog number ${id} cannot be represented in TLE format`);
}

export function gpToTLE(gp: SatelliteGP): string {
  // Standard TLE format. Column positions are 1-indexed per the canonical spec (e.g.
  // https://celestrak.org/NORAD/documentation/tle-fmt.php). Each data line is exactly 69
  // characters, with the final character being a modulo-10 checksum

  const catNum = formatCatalogNumber(gp.NoradCatalogId);
  const classification = (gp.ClassificationType || 'U').charAt(0);

  // Convert OMM OBJECT_ID "YYYY-NNNAAA" to TLE international designator "YYNNNAAA".
  let intlDes = '';
  const idMatch = /^(\d{4})-(\d{3})([A-Z]{1,3})$/.exec(gp.ObjectId);
  if (idMatch) {
    intlDes = idMatch[1].slice(2) + idMatch[2] + idMatch[3];
  }
  intlDes = intlDes.padEnd(8, ' ');

  // Epoch: 2-digit year + day-of-year with fractional part (3 int digits + '.' + 8 frac).
  // Parse the OMM EPOCH string directly rather than going through Date, because Date
  // only preserves millisecond precision but OMM epochs carry sub-millisecond fractional
  // seconds that affect the last digit of the TLE epoch field
  const epochMatch = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(
    gp.Epoch
  );
  if (!epochMatch) throw new Error(`Invalid EPOCH format: ${gp.Epoch}`);
  const year = parseInt(epochMatch[1], 10);
  const month = parseInt(epochMatch[2], 10);
  const dom = parseInt(epochMatch[3], 10);
  const hour = parseInt(epochMatch[4], 10);
  const minute = parseInt(epochMatch[5], 10);
  const second = parseFloat(epochMatch[6]);

  // Day-of-year for the calendar date (1-based)
  const startOfYearMs = Date.UTC(year, 0, 1);
  const dateMs = Date.UTC(year, month - 1, dom);
  const dayOfYearInt = Math.round((dateMs - startOfYearMs) / 86_400_000) + 1;
  const totalSeconds = hour * 3600 + minute * 60 + second;
  const dayFrac = totalSeconds / 86400;
  const yy = (year % 100).toString().padStart(2, '0');
  const epochStr = dayOfYearInt.toString().padStart(3, ' ') + dayFrac.toFixed(8).slice(1);

  // Eccentricity: 7-digit assumed-decimal field (leading "0." stripped).
  const eccStr = Math.round(gp.Eccentricity * 1e7)
    .toString()
    .padStart(7, '0');

  const inclStr = gp.Inclination.toFixed(4).padStart(8, ' ');
  const raanStr = gp.RaAscNode.toFixed(4).padStart(8, ' ');
  const argpStr = gp.ArgOfPericenter.toFixed(4).padStart(8, ' ');
  const maStr = gp.MeanAnomaly.toFixed(4).padStart(8, ' ');
  const mmStr = gp.MeanMotion.toFixed(8).padStart(11, ' ');
  const revStr = gp.RevAtEpoch.toString().padStart(5, ' ');
  const elsetStr = gp.ElementSetNumber.toString().padStart(4, ' ');

  // Line 0 is the 24-char object name. If the name is too long, truncate to 24 chars.
  // Celestrak's convention: if truncation occurs inside a parenthesized section, close
  // with "*)" (22 chars + "*)"); otherwise truncate to 23 chars and append "*".
  let name: string;
  if (gp.ObjectName.length > 24) {
    const openParen = gp.ObjectName.lastIndexOf('(');
    if (openParen >= 0 && openParen < 22) {
      name = gp.ObjectName.slice(0, 22) + '*)';
    } else {
      name = gp.ObjectName.slice(0, 23) + '*';
    }
  } else {
    name = gp.ObjectName.padEnd(24, ' ');
  }
  const line0 = name;

  const line1Body =
    `1 ${catNum}${classification} ${intlDes} ${yy}${epochStr} ` +
    `${formatFirstDeriv(gp.MeanMotionDot)} ${formatExp(gp.MeanMotionDdot)} ` +
    `${formatExp(gp.BStar)} ${gp.EphemerisType.toString()} ${elsetStr}`;
  const line1 = line1Body + checksum(line1Body);

  const line2Body =
    `2 ${catNum} ${inclStr} ${raanStr} ${eccStr} ${argpStr} ` +
    `${maStr} ${mmStr}${revStr}`;
  const line2 = line2Body + checksum(line2Body);

  return `${line0}\n${line1}\n${line2}`;
}
