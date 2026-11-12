const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('./db');
const { HttpError, ah, str, num } = require('./util');

const ROLES = ['ADMIN', 'BUYER', 'SUPPLIER', 'WAREHOUSE_MANAGER'];
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);   // equalises timing for unknown emails

// Creates USERS row + phones + the role's subclass row in ONE transaction.
async function createUser(d) {
  const role = d.role;
  if (!ROLES.includes(role)) throw new HttpError(400, 'Invalid role');
  const name = str(d.full_name, 'Full name', 100);
  const email = str(d.email, 'Email', 120).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address');
  if (typeof d.password !== 'string' || d.password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  let sub;
  if (role === 'BUYER' || role === 'SUPPLIER') {
    sub = [str(role === 'BUYER' ? d.company_name : d.business_name, role === 'BUYER' ? 'Company name' : 'Business name', 120),
           str(d.address, 'Address', 255), str(d.city, 'City', 60),
           num(d.latitude, 'Latitude', -90, 90), num(d.longitude, 'Longitude', -180, 180)];
  } else if (role === 'WAREHOUSE_MANAGER') {
    sub = [str(d.employee_code, 'Employee code', 20)];
  } else sub = [str(d.designation, 'Designation', 80, false) || 'Administrator'];
  const phones = String(d.phone || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);
  if (phones.some(p => p.length > 20)) throw new HttpError(400, 'Phone number is too long');

  const hash = await bcrypt.hash(d.password, 10);
  const cn = await pool.getConnection();
  try {
    await cn.beginTransaction();
    const [r] = await cn.execute('INSERT INTO USERS(full_name,email,password_hash,role) VALUES(?,?,?,?)', [name, email, hash, role]);
    const id = r.insertId;
    for (const p of phones) await cn.execute('INSERT INTO USER_PHONE(user_id,phone) VALUES(?,?)', [id, p]);
    if (role === 'BUYER') await cn.execute('INSERT INTO BUYER(user_id,company_name,address,city,latitude,longitude) VALUES(?,?,?,?,?,?)', [id, ...sub]);
    else if (role === 'SUPPLIER') await cn.execute('INSERT INTO SUPPLIER(user_id,business_name,address,city,latitude,longitude) VALUES(?,?,?,?,?,?)', [id, ...sub]);
    else if (role === 'WAREHOUSE_MANAGER') await cn.execute('INSERT INTO WAREHOUSE_MANAGER(user_id,employee_code,hire_date) VALUES(?,?,CURDATE())', [id, ...sub]);
    else await cn.execute('INSERT INTO ADMIN(user_id,designation) VALUES(?,?)', [id, ...sub]);
    await cn.commit();
    return id;
  } catch (e) {
    await cn.rollback();
    if (e.code === 'ER_DUP_ENTRY') {
      throw new HttpError(409, /employee_code/.test(e.sqlMessage) ? 'Employee code already in use' : 'That email is already registered');
    }
    throw e;
  } finally { cn.release(); }
}

async function profile(id) {
  const [[u]] = await pool.execute('SELECT user_id, full_name, email, role FROM USERS WHERE user_id=?', [id]);
  if (!u) return null;
  if (u.role === 'BUYER') {
    const [[b]] = await pool.execute('SELECT company_name, address, city, latitude, longitude FROM BUYER WHERE user_id=?', [id]);
    Object.assign(u, b, { org: b.company_name });
  } else if (u.role === 'SUPPLIER') {
    const [[s]] = await pool.execute('SELECT business_name, address, city, verification_status, reliability_score FROM SUPPLIER WHERE user_id=?', [id]);
    Object.assign(u, s, { org: s.business_name });
  }
  return u;
}

const router = express.Router();

router.post('/login', ah(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const role = req.body.role;
  const [[u]] = await pool.execute('SELECT user_id, full_name, role, password_hash, is_active FROM USERS WHERE email=?', [email]);
  const ok = await bcrypt.compare(password, u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok || (role && role !== u.role)) throw new HttpError(401, role ? `Wrong email or password for this role` : 'Wrong email or password');
  if (!u.is_active) throw new HttpError(403, 'This account has been deactivated. Contact an administrator.');
  await new Promise((ok2, bad) => req.session.regenerate(e => e ? bad(e) : ok2()));
  req.session.user = { id: u.user_id, role: u.role, name: u.full_name };
  res.json({ role: u.role });
}));

router.post('/register', ah(async (req, res) => {
  if (!['BUYER', 'SUPPLIER'].includes(req.body.role)) throw new HttpError(400, 'Only buyers and suppliers can register here');
  const id = await createUser(req.body);
  await new Promise((ok, bad) => req.session.regenerate(e => e ? bad(e) : ok()));
  req.session.user = { id, role: req.body.role, name: String(req.body.full_name).trim() };
  res.status(201).json({ role: req.body.role });
}));

router.post('/logout', (req, res) => req.session.destroy(() => { res.clearCookie('connect.sid'); res.json({ ok: true }); }));

router.get('/me', ah(async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not signed in' });
  const p = await profile(req.session.user.id);
  if (!p) return req.session.destroy(() => res.status(401).json({ error: 'Not signed in' }));
  res.json(p);
}));

const requireAuth = (req, res, next) => req.session.user ? next() : res.status(401).json({ error: 'Not signed in' });
const requireRole = (...roles) => (req, res, next) =>
  !req.session.user ? res.status(401).json({ error: 'Not signed in' })
  : roles.includes(req.session.user.role) ? next() : res.status(403).json({ error: 'Your role cannot do this' });

module.exports = { router, requireAuth, requireRole, createUser };
