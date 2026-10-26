import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';

const passwordSchema = z.string().min(10).max(72).refine(v => Buffer.byteLength(v, 'utf8') <= 72, 'Password must be at most 72 bytes.').regex(/[a-z]/, 'Include a lowercase letter.').regex(/[A-Z]/, 'Include an uppercase letter.').regex(/[0-9]/, 'Include a number.');
const emailSchema = z.string().trim().toLowerCase().email().max(254);
const nameSchema = z.string().trim().min(2).max(70);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(v); return !Number.isNaN(d.getTime()) && d.toISOString().slice(0,10) === v && v >= '2000-01-01' && v <= '2100-12-31'; }, 'Enter a valid date between 2000 and 2100.');
const parcelSchema = z.object({ title: z.string().trim().min(2).max(100), courier: z.string().trim().min(2).max(50), tracking: z.string().trim().max(100).default(''), expected_date: dateSchema, status: z.enum(['expected','out_for_delivery','received']).default('expected'), notes: z.string().trim().max(1000).default('') });
const safeUser = u => ({ id: u.id, name: u.name, email: u.email, created_at: u.created_at });
const parse = (schema, body) => { const r = schema.safeParse(body); if (!r.success) { const e = new Error(r.error.issues[0].message); e.status = 400; throw e; } return r.data; };
const fail = (status, message) => Object.assign(new Error(message), { status });

export function createApp({ store, secret, production = false, origin, tokenExpiry = '30m', rateLimits = true }) {
  if (!secret || secret.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters.');
  if (production && !origin?.startsWith('https://')) throw new Error('APP_ORIGIN must be the HTTPS public origin in production.');
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'], fontSrc: ["'self'"], connectSrc: ["'self'"], upgradeInsecureRequests: production ? [] : null } } }));
  app.use(express.json({ limit: '16kb' }), cookieParser());
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
      const allowed = origin || `${req.protocol}://${req.get('host')}`;
      if ((req.get('origin') && req.get('origin') !== allowed) || req.get('sec-fetch-site') === 'cross-site') return next(fail(403, 'Request origin is not allowed.'));
    }
    next();
  });
  if (rateLimits) {
    app.use('/api', rateLimit({ windowMs: 60000, limit: 180, standardHeaders: 'draft-8', legacyHeaders: false, message: { message: 'Too many requests. Please try again shortly.' } }));
    const authLimit = rateLimit({ windowMs: 15 * 60000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { message: 'Too many sign-in attempts. Try again in 15 minutes.' } });
    app.use(['/api/auth/login','/api/auth/register','/api/auth/password'], authLimit);
  }
  const cookie = { httpOnly: true, secure: production, sameSite: 'strict', path: '/' };
  const authenticate = async (req, res, next) => {
    try {
      const token = req.cookies.parcelpass_session || req.get('authorization')?.replace(/^Bearer /i, '');
      const claims = jwt.verify(token || '', secret, { algorithms: ['HS256'], issuer: 'parcelpass', audience: 'parcelpass-app' });
      const { rows } = await store.query('SELECT users.* FROM users JOIN sessions ON sessions.user_id = users.id WHERE users.id = $1 AND sessions.id = $2 AND sessions.expires_at > $3', [claims.sub, claims.jti, new Date().toISOString()]);
      if (!rows[0]) throw fail(401, 'Your session has ended. Please sign in again.');
      req.user = rows[0]; req.sessionId = claims.jti; req.expiresAt = new Date(claims.exp * 1000).toISOString();
      next();
    } catch (e) { if (e.status || e instanceof jwt.JsonWebTokenError || e instanceof jwt.TokenExpiredError) next(fail(401, 'Your session has ended. Please sign in again.')); else next(e); }
  };
  const startSession = async (res, user) => {
    const sid = randomUUID();
    const token = jwt.sign({}, secret, { algorithm: 'HS256', subject: user.id, jwtid: sid, issuer: 'parcelpass', audience: 'parcelpass-app', expiresIn: tokenExpiry });
    const expiresAt = new Date(jwt.decode(token).exp * 1000).toISOString();
    await store.query('DELETE FROM sessions WHERE expires_at <= $1', [new Date().toISOString()]);
    await store.query('INSERT INTO sessions (id,user_id,expires_at,created_at) VALUES ($1,$2,$3,$4)', [sid, user.id, expiresAt, new Date().toISOString()]);
    res.cookie('parcelpass_session', token, { ...cookie, expires: new Date(expiresAt) });
    return { user: safeUser(user), expiresAt };
  };
  app.get('/api/health', async (req,res) => { await store.query('SELECT 1'); res.json({ status: 'ok', service: 'parcelpass' }); });
  app.post('/api/auth/register', async (req,res) => {
    const input = parse(z.object({ name: nameSchema, email: emailSchema, password: passwordSchema }), req.body);
    const user = { id: randomUUID(), ...input, password: await bcrypt.hash(input.password, 12), created_at: new Date().toISOString() };
    try { await store.query('INSERT INTO users (id,name,email,password,created_at) VALUES ($1,$2,$3,$4,$5)', [user.id,user.name,user.email,user.password,user.created_at]); }
    catch (e) { if (e.code === '23505' || e.code === 'ERR_SQLITE_ERROR' && /UNIQUE/.test(e.message)) throw fail(409, 'An account with this email already exists.'); throw e; }
    res.status(201).json(await startSession(res,user));
  });
  app.post('/api/auth/login', async (req,res) => {
    const input = parse(z.object({ email: emailSchema, password: z.string().min(1).max(200) }), req.body);
    const { rows } = await store.query('SELECT * FROM users WHERE email = $1', [input.email]);
    const valid = await bcrypt.compare(input.password, rows[0]?.password || '$2b$12$YsA3F89LCKpycU1atq11.OJI5nDIDY2lWmdAtQlWVCB9l7jZ3d8TW');
    if (!rows[0] || !valid) throw fail(401, 'Email or password is incorrect.');
    res.json(await startSession(res,rows[0]));
  });
  app.get('/api/auth/me', authenticate, (req,res) => res.json({ user: safeUser(req.user), expiresAt: req.expiresAt }));
  app.post('/api/auth/logout', authenticate, async (req,res) => {
    await store.query('DELETE FROM sessions WHERE id = $1', [req.sessionId]);
    res.clearCookie('parcelpass_session',cookie).json({ message: 'Signed out securely.' });
  });
  app.patch('/api/auth/profile', authenticate, async (req,res) => {
    const { name } = parse(z.object({ name: nameSchema }),req.body);
    await store.query('UPDATE users SET name = $1 WHERE id = $2', [name,req.user.id]);
    res.json({ user: safeUser({ ...req.user, name }) });
  });
  app.patch('/api/auth/password', authenticate, async (req,res) => {
    const { currentPassword, newPassword } = parse(z.object({ currentPassword: z.string().max(200), newPassword: passwordSchema }),req.body);
    if (!await bcrypt.compare(currentPassword,req.user.password)) throw fail(400,'Current password is incorrect.');
    await store.query('UPDATE users SET password = $1 WHERE id = $2', [await bcrypt.hash(newPassword,12),req.user.id]);
    await store.query('DELETE FROM sessions WHERE user_id = $1', [req.user.id]);
    res.clearCookie('parcelpass_session',cookie).json({ message: 'Password updated. Sign in again on all devices.' });
  });
  app.delete('/api/auth/account', authenticate, async (req,res) => {
    const { password } = parse(z.object({ password: z.string().min(1).max(200) }),req.body);
    if (!await bcrypt.compare(password,req.user.password)) throw fail(400,'Password is incorrect.');
    await store.query('DELETE FROM users WHERE id = $1', [req.user.id]);
    res.clearCookie('parcelpass_session',cookie).json({ message: 'Your account and parcels have been deleted.' });
  });
  app.get('/api/parcels', authenticate, async (req,res) => {
    const { rows } = await store.query('SELECT * FROM parcels WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    res.json({ parcels: rows.map(({ user_id, ...p }) => p) });
  });
  app.post('/api/parcels', authenticate, async (req,res) => {
    const p = parse(parcelSchema, req.body), id = randomUUID(), now = new Date().toISOString();
    const { rows } = await store.query('INSERT INTO parcels (id,user_id,title,courier,tracking,expected_date,status,notes,received_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING *', [id,req.user.id,p.title,p.courier,p.tracking,p.expected_date,p.status,p.notes,p.status === 'received' ? now : null,now]);
    const {user_id,...parcel}=rows[0]; res.status(201).json({ parcel });
  });
  app.patch('/api/parcels/:id', authenticate, async (req,res) => {
    const input = parse(parcelSchema.extend({ version: z.number().int().positive() }), req.body);
    const now = new Date().toISOString();
    const { rows: existing } = await store.query('SELECT * FROM parcels WHERE id = $1 AND user_id = $2', [req.params.id,req.user.id]);
    if (!existing[0]) throw fail(404,'Parcel not found.');
    const received = input.status === 'received' ? existing[0].received_at || now : null;
    const { rows } = await store.query('UPDATE parcels SET title=$1,courier=$2,tracking=$3,expected_date=$4,status=$5,notes=$6,received_at=$7,updated_at=$8,version=version+1 WHERE id=$9 AND user_id=$10 AND version=$11 RETURNING *', [input.title,input.courier,input.tracking,input.expected_date,input.status,input.notes,received,now,req.params.id,req.user.id,input.version]);
    if (!rows[0]) throw fail(409,'This parcel changed in another window. Refresh and try again.');
    const {user_id,...parcel}=rows[0]; res.json({ parcel });
  });
  app.delete('/api/parcels/:id', authenticate, async (req,res) => {
    const { rows } = await store.query('DELETE FROM parcels WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id,req.user.id]);
    if (!rows[0]) throw fail(404,'Parcel not found.');
    res.status(204).end();
  });
  app.use('/api', (req,res,next) => next(fail(404,'Endpoint not found.')));
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url)), { maxAge: production ? '1h' : 0 }));
  app.use((req,res) => res.status(404).send('Page not found.'));
  app.use((err,req,res,next) => {
    const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
    if (status >= 500) console.error('Request failed:', err.code || err.name);
    res.status(status).json({ message: status >= 500 ? 'Something went wrong. Please try again.' : err.message });
  });
  return app;
}
