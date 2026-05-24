import { parse } from 'csv-parse/sync';
import { SatelliteGP } from './gp';

type CsvRecord = Record<string, string>;

function parseSatelliteGPLine(record: CsvRecord): SatelliteGP {
  const str = (col: string) => {
    const v = record[col];
    if (v === undefined) throw new Error(`Missing field: ${col}`);
    return v.trim();
  };
  const num = (col: string) => {
    const v = Number(str(col));
    if (isNaN(v)) throw new Error(`Invalid number for field ${col}: ${record[col]}`);
    return v;
  };

  return {
    ObjectName: str('OBJECT_NAME'),
    ObjectId: str('OBJECT_ID'),
    Epoch: str('EPOCH'),
    MeanMotion: num('MEAN_MOTION'),
    Eccentricity: num('ECCENTRICITY'),
    Inclination: num('INCLINATION'),
    RaAscNode: num('RA_OF_ASC_NODE'),
    ArgOfPericenter: num('ARG_OF_PERICENTER'),
    MeanAnomaly: num('MEAN_ANOMALY'),
    EphemerisType: num('EPHEMERIS_TYPE'),
    ClassificationType: str('CLASSIFICATION_TYPE'),
    NoradCatalogId: num('NORAD_CAT_ID'),
    ElementSetNumber: num('ELEMENT_SET_NO'),
    RevAtEpoch: num('REV_AT_EPOCH'),
    BStar: num('BSTAR'),
    MeanMotionDot: num('MEAN_MOTION_DOT'),
    MeanMotionDdot: num('MEAN_MOTION_DDOT')
  };
}

export function csvToSatelliteGP(csv: string): SatelliteGP[] {
  let records: CsvRecord[];
  try {
    records = parse(csv, {
      columns: true,
      skip_empty_lines: true,
      trim: false,
      bom: true
    }) as CsvRecord[];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const preview = csv.slice(0, 200);
    console.log(
      `[csv] Error parsing csv: size=${csv.length} chars, error="${message}", preview="${preview}"`
    );
    return [];
  }

  if (records.length === 0) {
    const preview = csv.slice(0, 200);
    console.log(
      `[csv] Error converting csv: size=${csv.length} chars, records=0, preview="${preview}"`
    );
    return [];
  }

  return records.map(parseSatelliteGPLine);
}
