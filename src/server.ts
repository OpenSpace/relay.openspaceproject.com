import express from 'express';
import config from '../config.json';
import * as celestrak from './celestrak/handler';

celestrak.initialize();

const app = express();
celestrak.registerHandlers(app);

const PORT = config.port;
app.listen(PORT, () => {
  console.log(`Celestrak relay listening on http://localhost:${PORT}`);
});
