require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const auth = require('./src/auth');
const routes = require('./src/routes');
const { HttpError } = require('./src/util');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
  resave: false, saveUninitialized: false, name: 'connect.sid',
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 3600 * 1000 }
}));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  next();
});

app.use('/api/auth', auth.router);
app.use('/api', routes);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(path.join(__dirname, 'public')));

// Central error handler: turns DBMS rejections into readable messages.
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON' });
  const map = {
    ER_SIGNAL_EXCEPTION: [400, err.sqlMessage],
    ER_CHECK_CONSTRAINT_VIOLATED: [400, 'That value is outside the allowed range (database constraint)'],
    ER_DUP_ENTRY: [409, 'That record already exists'],
    ER_NO_REFERENCED_ROW_2: [400, 'Refers to a record that does not exist'],
    ER_ROW_IS_REFERENCED_2: [409, 'This record is still in use and cannot be removed']
  };
  const m = map[err.code];
  if (m) return res.status(m[0]).json({ error: m[1] });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Procura running at http://localhost:${port}`));
