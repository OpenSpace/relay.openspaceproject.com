import express from 'express';
import config from '../config.json';
import * as celestrak from './celestrak/handler';

celestrak.initialize();

const app = express();
celestrak.registerHandlers(app);

app.listen(config.port, () => {
  console.log(`Celestrak relay listening on http://localhost:${config.port}`);
});
