import { SatelliteGP } from './gp';

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

export function csvToSatelliteGP(csv: string): SatelliteGP[] {
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
