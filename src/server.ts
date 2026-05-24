import express from 'express';
import config from '../config.json';

import { loadCacheFromDisk, makeCelestrakHandler } from './celestrak/handler';

const app = express();
const PORT = config.port;

const CELESTRAK_GP_BASE = 'https://celestrak.org/NORAD/elements/gp.php';
const CELESTRAK_SUP_GP_BASE =
  'https://celestrak.org/NORAD/elements/supplemental/sup-gp.php';

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
});
