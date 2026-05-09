const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { version: apiVersion } = require('../package.json');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false }));

app.get('/healthz', (req, res) => res.sendStatus(200));

app.get('/api/meta', (req, res) => {
  const env = process.env.APP_ENV || process.env.NODE_ENV || 'unknown';
  res.json({ version: apiVersion, env });
});

app.use('/api/groups', require('./routes/groups'));
app.use('/api/regions', require('./routes/regions'));
app.use('/api/provinces', require('./routes/provinces'));
app.use('/api/municipalities', require('./routes/municipalities'));
app.use('/api/protected-areas', require('./routes/protected_areas'));

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => console.log(`API listening on :${PORT}`));
