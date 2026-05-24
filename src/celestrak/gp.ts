export interface SatelliteGP {
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
