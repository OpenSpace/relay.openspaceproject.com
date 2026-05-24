/**
 * Parsed General Perturbations (GP) orbital element set for a single satellite.
 * Field semantics follow the CCSDS Orbit Data Messages standard (502.0-B-3),
 * specifically the Orbit Mean-Elements Message (OMM) schema using SGP/SGP4 theory.
 * See https://ccsds.org/Pubs/502x0b3e1.pdf for the full documentation
 */
export interface SatelliteGP {
  /// Satellite common name
  /// CCSDS: OBJECT_NAME
  ObjectName: string;

  /// International designator in the form YYYY-NNNPPP
  /// CCSDS: OBJECT_ID
  ObjectId: string;

  /// UTC epoch of the element set in ISO 8601 format
  /// CCSDS: EPOCH
  Epoch: string;

  /// Mean motion in revolutions per day
  /// CCSDS: MEAN_MOTION
  MeanMotion: number;

  /// Orbit eccentricity, dimensionless, 0 <= e < 1
  /// CCSDS: ECCENTRICITY
  Eccentricity: number;

  /// Orbital inclination in degrees
  /// CCSDS: INCLINATION
  Inclination: number;

  /// Right ascension of the ascending node in degrees
  /// CCSDS: RA_OF_ASC_NODE
  RaAscNode: number;

  /// Argument of pericenter in degrees
  /// CCSDS: ARG_OF_PERICENTER
  ArgOfPericenter: number;

  /// Mean anomaly in degrees
  /// CCSDS: MEAN_ANOMALY
  MeanAnomaly: number;

  /// Ephemeris type indicator; 0 = SGP4
  /// CCSDS: EPHEMERIS_TYPE
  EphemerisType: number;

  /// Classification type: 'U' unclassified, 'C' classified, 'S' secret
  /// CCSDS: CLASSIFICATION_TYPE
  ClassificationType: string;

  /// NORAD catalog number
  /// CCSDS: NORAD_CAT_ID
  NoradCatalogId: number;

  /// Element set number; incremented on each new TLE generation
  /// CCSDS: ELEMENT_SET_NO
  ElementSetNumber: number;

  /// Revolution number at epoch
  /// CCSDS: REV_AT_EPOCH
  RevAtEpoch: number;

  /// B* radiation pressure drag coefficient in 1/Earth-radii
  /// CCSDS: BSTAR
  BStar: number;

  /// First time derivative of mean motion divided by 2, in rev/day^2
  /// CCSDS: MEAN_MOTION_DOT
  MeanMotionDot: number;

  /// Second time derivative of mean motion divided by 6, in rev/day^3
  /// CCSDS: MEAN_MOTION_DDOT
  MeanMotionDdot: number;
}
