import { SatelliteGP } from './gp';

export function gpToOMM(gp: SatelliteGP): string {
  // Leaving the CREATION_DATE and ORIGINATOR field empty for compatibility with the
  // Celestrak result

  // Eccentricity: Celestrak strips leading zero (0.001 -> .001)
  const eccStr = gp.Eccentricity.toString().replace(/^0\./, '.');

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
ECCENTRICITY   = ${eccStr}
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
