'use strict';

const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Pool, types } = require('pg');
const fs = require('fs/promises');
const path = require('path');

// DATE-Spalten als Text 'YYYY-MM-DD' lesen statt als JS-Date. Ein JS-Date wird je nach
// Server-Zeitzone um einen Tag verschoben (z. B. TZ=Europe/Zurich: 06.11. -> 2026-11-05T23:00Z)
// und String(date).slice(0,10) ergibt 'Fri Nov 06' statt eines ISO-Datums.
types.setTypeParser(1082, v => v);

// Unerwartete Promise-Fehler protokollieren, statt den ganzen Prozess zu beenden.
process.on('unhandledRejection', err => console.error('Unbehandelter Fehler:', err));

const PORT = Number(process.env.PORT || 3000);
const DATABASE_URL = process.env.DATABASE_URL || '';
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const ADMIN_USER = process.env.APP_ADMIN_USER || 'admin';
const ADMIN_PASSWORD_HASH = process.env.APP_ADMIN_PASSWORD_HASH || '';
const ENCRYPTION_KEY_HEX = process.env.APP_ENCRYPTION_KEY || '';
const BEXIO_CLIENT_ID = process.env.BEXIO_CLIENT_ID || '';
const BEXIO_CLIENT_SECRET = process.env.BEXIO_CLIENT_SECRET || '';
const BEXIO_REDIRECT_URI = process.env.BEXIO_REDIRECT_URI || `${APP_BASE_URL}/auth/bexio/callback`;
const BEXIO_SCOPES = process.env.BEXIO_SCOPES || 'openid offline_access contact_show article_show kb_order_edit kb_delivery_edit';
const CONTACT_GROUP_NAMES = csv(process.env.BEXIO_CONTACT_GROUPS || 'Detailhandel,Gastronomie');
const ARTICLE_GROUP_NAMES = csv(process.env.BEXIO_ARTICLE_GROUPS || 'Frischpilze,Dörrpilze,Fertig Produkte');
const ARTICLE_GROUP_IDS = csv(process.env.BEXIO_ARTICLE_GROUP_IDS || '9,11,12').map(Number).filter(Number.isFinite);
const CONTACT_BRANCH_NAMES = csv(process.env.BEXIO_CONTACT_BRANCHES || 'Detailhandel,Gastronomie');
const CONTACT_GROUP_IDS = csv(process.env.BEXIO_CONTACT_GROUP_IDS || '').map(Number).filter(Number.isFinite);
const CONTACT_BRANCH_IDS = csv(process.env.BEXIO_CONTACT_BRANCH_IDS || '').map(Number).filter(Number.isFinite);
const ORDER_TITLE_TEMPLATE = process.env.MONTHLY_ORDER_TITLE_TEMPLATE || 'Sammelrechnung {month} {year}';
const AUTO_CREATE_ORDER = String(process.env.AUTO_CREATE_MONTHLY_ORDER || 'true').toLowerCase() === 'true';
const DRY_RUN = String(process.env.BEXIO_DRY_RUN || 'true').toLowerCase() === 'true';
const DELIVERY_PDF_TEMPLATE = process.env.BEXIO_DELIVERY_PDF_ENDPOINT_TEMPLATE || '';
const PASSWORD_RESET_TOKEN = process.env.PASSWORD_RESET_TOKEN || '';
const LOGIN_RECOVERY_TOKEN = process.env.LOGIN_RECOVERY_TOKEN || '';

if (!DATABASE_URL) throw new Error('DATABASE_URL fehlt.');
if (!SESSION_SECRET || SESSION_SECRET.length < 24) throw new Error('SESSION_SECRET fehlt oder ist zu kurz.');
if (!ENCRYPTION_KEY_HEX || ENCRYPTION_KEY_HEX.length < 32) throw new Error('APP_ENCRYPTION_KEY fehlt oder ist zu kurz (mind. 32 Zeichen).');

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
});

const app = express();

// Express 4 leitet Fehler aus async-Handlern nicht an die Fehlerbehandlung weiter.
// Ohne diesen Wrapper führt z. B. ein kurzer bexio-Ausfall beim Erfassen einer
// Bestellung zu einem unbehandelten Fehler. Alle Routen-Handler werden deshalb
// so gekapselt, dass Fehler als HTTP 500 beantwortet werden.
function wrapAsync(fn) {
  if (typeof fn !== 'function' || fn.length === 4) return fn;
  return function wrapped(req, res, next) {
    try {
      const result = fn(req, res, next);
      if (result && typeof result.catch === 'function') result.catch(next);
    } catch (err) { next(err); }
  };
}
for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
  const original = app[method].bind(app);
  app[method] = (route, ...handlers) => {
    if (method === 'get' && handlers.length === 0) return original(route); // app.get('setting')
    return original(route, ...handlers.map(wrapAsync));
  };
}

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  referrerPolicy: { policy: 'no-referrer' }
}));
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: false, limit: '128kb' }));
app.use(session({
  store: new pgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  name: 'bexio_portal_sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000
  }
}));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 240, standardHeaders: true, legacyHeaders: false });
app.use('/api', apiLimiter);

function csv(v) { return String(v).split(',').map(x => x.trim()).filter(Boolean); }
function norm(v) { return String(v || '').trim().toLocaleLowerCase('de-CH'); }
function uuid() { return crypto.randomUUID(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function normalizePassword(v) { return String(v || '').normalize('NFC'); }
// Heutiges Datum in Schweizer Zeit als 'YYYY-MM-DD' (unabhängig von der Server-Zeitzone).
function zurichToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Bestellungen, die länger als STALE_PROCESSING_MINUTES im Status 'processing' stehen,
// wurden unterbrochen (Neustart, Deploy, Absturz). Sie werden auf 'failed' gesetzt und
// können danach normal erneut verarbeitet werden. Bereits gespeicherte bexio-IDs bleiben
// erhalten, ein Retry setzt also beim letzten erfolgreichen Schritt fort.
const STALE_PROCESSING_MINUTES = 10;
async function releaseStaleProcessing(db = pool) {
  await db.query(
    `UPDATE draft_orders
     SET status='failed',
         error_message='Verarbeitung wurde unterbrochen (z. B. Server-Neustart). Bitte erneut erstellen – bereits angelegte bexio-Schritte werden nicht doppelt ausgeführt.',
         updated_at=now()
     WHERE status='processing' AND updated_at < now() - ($1 || ' minutes')::interval`,
    [String(STALE_PROCESSING_MINUTES)]
  );
}



function secureTokenEqual(a, b) {
  const ah = crypto.createHash('sha256').update(String(a || ''), 'utf8').digest();
  const bh = crypto.createHash('sha256').update(String(b || ''), 'utf8').digest();
  return crypto.timingSafeEqual(ah, bh);
}

function resetPage(message = '', isError = false) {
  const escaped = String(message || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  const notice = escaped ? `<div class="notice ${isError ? 'error' : 'ok'}">${escaped}</div>` : '';
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Passwort zurücksetzen · bexio Lieferportal</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f7f5;color:#102b27;margin:0;min-height:100vh;display:grid;place-items:center}
.card{width:min(520px,calc(100% - 32px));background:white;border:1px solid #dbe4df;border-radius:18px;padding:30px;box-shadow:0 8px 30px rgba(0,0,0,.06)}
h1{margin:0 0 8px;font-size:28px}.hint{color:#586a66;margin:0 0 22px;line-height:1.45}label{display:block;font-weight:700;margin:14px 0 6px}input{box-sizing:border-box;width:100%;padding:13px 14px;border:1px solid #bdcbc6;border-radius:10px;font-size:16px}button{margin-top:20px;background:#21623f;color:white;border:0;border-radius:10px;padding:13px 18px;font-weight:700;font-size:16px;cursor:pointer}.notice{padding:12px 14px;border-radius:10px;margin:14px 0}.error{background:#fff0f0;color:#8a1f1f}.ok{background:#ecf8ef;color:#175b34}.back{display:inline-block;margin-top:18px;color:#21623f}
</style></head><body><main class="card"><h1>Admin-Passwort zurücksetzen</h1>
<p class="hint">Diese Seite funktioniert nur, solange in Render vorübergehend <code>PASSWORD_RESET_TOKEN</code> gesetzt ist. Nach erfolgreichem Reset die Variable wieder löschen.</p>
${notice}
<form method="post" action="/password-reset" autocomplete="off">
<label for="username">Benutzername</label><input id="username" name="username" required maxlength="64" autocomplete="username">
<label for="token">Temporärer Reset-Code</label><input id="token" name="token" type="password" required autocomplete="off">
<label for="password">Neues Passwort</label><input id="password" name="password" type="password" minlength="12" required autocomplete="new-password">
<label for="passwordConfirm">Passwort wiederholen</label><input id="passwordConfirm" name="passwordConfirm" type="password" minlength="12" required autocomplete="new-password">
<button type="submit">Passwort zurücksetzen</button></form><a class="back" href="/">Zurück zum Login</a></main></body></html>`;
}


function loginRecoveryPage(message = '', isError = false) {
  const escaped = String(message || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  const notice = escaped ? `<div class="notice ${isError ? 'error' : 'ok'}">${escaped}</div>` : '';
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin-Login neu anlegen · bexio Lieferportal</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f7f5;color:#102b27;margin:0;min-height:100vh;display:grid;place-items:center}
.card{width:min(540px,calc(100% - 32px));background:white;border:1px solid #dbe4df;border-radius:18px;padding:30px;box-shadow:0 8px 30px rgba(0,0,0,.06)}
h1{margin:0 0 8px;font-size:28px}.hint{color:#586a66;margin:0 0 22px;line-height:1.5}label{display:block;font-weight:700;margin:14px 0 6px}input{box-sizing:border-box;width:100%;padding:13px 14px;border:1px solid #bdcbc6;border-radius:10px;font-size:16px}button{margin-top:20px;background:#21623f;color:white;border:0;border-radius:10px;padding:13px 18px;font-weight:700;font-size:16px;cursor:pointer}.notice{padding:12px 14px;border-radius:10px;margin:14px 0}.error{background:#fff0f0;color:#8a1f1f}.ok{background:#ecf8ef;color:#175b34}.back{display:inline-block;margin-top:18px;color:#21623f}code{background:#eef3f0;padding:2px 5px;border-radius:5px}
</style></head><body><main class="card"><h1>Admin-Login neu anlegen</h1>
<p class="hint">Hier brauchst du den bisherigen Benutzernamen und das alte Passwort nicht. Die Seite ist nur aktiv, solange in Render vorübergehend <code>LOGIN_RECOVERY_TOKEN</code> gesetzt ist. Bestellungen und bexio-Daten bleiben unverändert.</p>
${notice}
<form method="post" action="/login-recovery" autocomplete="off">
<label for="token">Temporärer Wiederherstellungs-Code</label><input id="token" name="token" type="password" required autocomplete="off">
<label for="username">Neuer Admin-Benutzername</label><input id="username" name="username" required minlength="3" maxlength="64" autocomplete="username">
<label for="password">Neues Passwort</label><input id="password" name="password" type="password" minlength="12" required autocomplete="new-password">
<label for="passwordConfirm">Passwort wiederholen</label><input id="passwordConfirm" name="passwordConfirm" type="password" minlength="12" required autocomplete="new-password">
<button type="submit">Admin-Login neu anlegen</button></form><a class="back" href="/">Zurück zum Login</a></main></body></html>`;
}

function encryptionKey() { return crypto.createHash('sha256').update(ENCRYPTION_KEY_HEX).digest(); }

function encrypt(value) {
  const key = encryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decrypt(payload) {
  const key = encryptionKey();
  const data = Buffer.from(payload, 'base64');
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const encrypted = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

async function initDb() {
  const schema = await fs.readFile(path.join(__dirname, 'sql', 'schema.sql'), 'utf8');
  await pool.query(schema);
  const existing = await pool.query('SELECT id FROM app_users WHERE username=$1', [ADMIN_USER]);
  if (!existing.rowCount && ADMIN_PASSWORD_HASH) {
    await pool.query('INSERT INTO app_users(username,password_hash,role) VALUES($1,$2,$3)', [ADMIN_USER, ADMIN_PASSWORD_HASH, 'admin']);
    console.log(`Admin-Benutzer ${ADMIN_USER} angelegt.`);
  }
}

async function audit(req, action, entityType = null, entityId = null, metadata = null) {
  try {
    await pool.query(
      'INSERT INTO audit_log(user_id,action,entity_type,entity_id,metadata,ip) VALUES($1,$2,$3,$4,$5,$6)',
      [req.session?.user?.id || null, action, entityType, entityId ? String(entityId) : null, metadata, req.ip || null]
    );
  } catch (e) { console.error('Audit error:', e.message); }
}

function requireLogin(req, res, next) {
  if (req.session?.user?.id) return next();
  res.status(401).json({ error: 'Nicht angemeldet.' });
}

function requireAdmin(req, res, next) {
  if (req.session?.user?.id && req.session?.user?.role === 'admin') return next();
  res.status(403).json({ error: 'Nur Administratoren dürfen diese Einstellung ändern.' });
}

async function hasAnyUser() {
  const r = await pool.query('SELECT 1 FROM app_users LIMIT 1');
  return r.rowCount > 0;
}

function issueCsrf(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  return req.session.csrf;
}

function requireCsrf(req, res, next) {
  const sent = req.get('x-csrf-token') || req.body?._csrf;
  if (sent && req.session?.csrf) {
    const a = Buffer.from(String(sent)); const b = Buffer.from(String(req.session.csrf));
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  }
  res.status(403).json({ error: 'Ungültiges CSRF-Token.' });
}

async function secretSet(key, value) {
  await pool.query(
    `INSERT INTO app_secrets(key,value_encrypted,updated_at) VALUES($1,$2,now())
     ON CONFLICT(key) DO UPDATE SET value_encrypted=EXCLUDED.value_encrypted, updated_at=now()`,
    [key, encrypt(value)]
  );
}
async function secretGet(key) {
  const r = await pool.query('SELECT value_encrypted FROM app_secrets WHERE key=$1', [key]);
  return r.rowCount ? decrypt(r.rows[0].value_encrypted) : null;
}

async function getTokens() {
  const raw = await secretGet('bexio_tokens');
  return raw ? JSON.parse(raw) : null;
}
async function saveTokens(tokens) { await secretSet('bexio_tokens', JSON.stringify(tokens)); }

async function refreshBexioToken(tokens) {
  if (!tokens?.refresh_token) throw new Error('Kein bexio Refresh Token vorhanden.');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id: BEXIO_CLIENT_ID,
    client_secret: BEXIO_CLIENT_SECRET
  });
  const r = await fetch('https://auth.bexio.com/realms/bexio/protocol/openid-connect/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body
  });
  if (!r.ok) throw new Error(`bexio Token-Refresh fehlgeschlagen (${r.status}).`);
  const next = await r.json();
  const merged = { ...tokens, ...next, obtained_at: Date.now() };
  await saveTokens(merged);
  return merged;
}

async function accessToken() {
  let tokens = await getTokens();
  if (!tokens?.access_token) throw new Error('bexio ist noch nicht verbunden.');
  const expiresMs = (Number(tokens.expires_in || 300) * 1000);
  const obtained = Number(tokens.obtained_at || 0);
  if (Date.now() > obtained + expiresMs - 60_000) tokens = await refreshBexioToken(tokens);
  return tokens.access_token;
}

async function bexio(pathname, options = {}) {
  const token = await accessToken();
  const r = await fetch(`https://api.bexio.com${pathname}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (r.status === 401) {
    const tokens = await getTokens();
    if (tokens?.refresh_token && !options.__retried) {
      await refreshBexioToken(tokens);
      return bexio(pathname, { ...options, __retried: true });
    }
  }
  if (!r.ok) {
    const msg = typeof data === 'string' ? data.slice(0, 500) : JSON.stringify(data).slice(0, 500);
    throw new Error(`bexio ${options.method || 'GET'} ${pathname}: ${r.status} ${msg}`);
  }
  return data;
}

async function paged(pathname) {
  const all = [];
  for (let offset = 0; offset < 10000; offset += 2000) {
    const join = pathname.includes('?') ? '&' : '?';
    const part = await bexio(`${pathname}${join}limit=2000&offset=${offset}`);
    if (!Array.isArray(part)) return part;
    all.push(...part);
    if (part.length < 2000) break;
  }
  return all;
}

async function fetchBexioCatalogBase() {
  const [contacts, contactGroups, contactBranches, articles, units] = await Promise.all([
    paged('/2.0/contact'), paged('/2.0/contact_group'), paged('/2.0/contact_branch'), paged('/2.0/article'), paged('/2.0/unit')
  ]);
  const unitMap = new Map((units || []).map(u => [Number(u.id), u.name || u.short_name || '']));
  const allowedContactGroupIds = new Set([
    ...CONTACT_GROUP_IDS,
    ...(contactGroups || []).filter(g => CONTACT_GROUP_NAMES.some(n => norm(n) === norm(g.name))).map(g => Number(g.id))
  ]);
  const allowedContactBranchIds = new Set([
    ...CONTACT_BRANCH_IDS,
    ...(contactBranches || []).filter(b => CONTACT_BRANCH_NAMES.some(n => norm(n) === norm(b.name))).map(b => Number(b.id))
  ]);
  const allowedArticleGroupIds = new Set(ARTICLE_GROUP_IDS);

  const parseIds = (value) => {
    const raw = Array.isArray(value) ? value : String(value || '').split(',');
    return raw.map(x => Number(String(x).trim())).filter(Number.isFinite);
  };

  const allowedContacts = (contacts || []).filter(c => {
    const groupIds = parseIds(c.contact_group_ids);
    const branchIds = parseIds(c.contact_branch_ids);
    const matchesGroup = groupIds.some(id => allowedContactGroupIds.has(id));
    const matchesBranch = branchIds.some(id => allowedContactBranchIds.has(id));
    return matchesGroup || matchesBranch;
  }).map(c => ({ id: c.id, name: [c.name_1, c.name_2].filter(Boolean).join(' '), city: c.city || '', nr: c.nr || '' }))
    .sort((a,b) => a.name.localeCompare(b.name, 'de'));

  const articleSource = ARTICLE_GROUP_IDS.length
    ? (articles || []).filter(a => allowedArticleGroupIds.has(Number(a.article_group_id)))
    : (articles || []);

  const candidateArticles = articleSource.map(a => ({
    id: Number(a.id),
    name: a.intern_name || a.deliverer_name || `Artikel ${a.id}`,
    code: a.intern_code || '',
    unit_id: a.unit_id,
    account_id: a.account_id,
    tax_id: a.tax_id || a.tax_income_id,
    sale_price: a.sale_price,
    group_id: a.article_group_id,
    unit_name: unitMap.get(Number(a.unit_id)) || ''
  })).sort((a,b) => a.name.localeCompare(b.name, 'de'));

  const sampleMap = new Map();
  for (const a of (articles || [])) {
    const gid = Number(a.article_group_id);
    if (!Number.isFinite(gid)) continue;
    if (!sampleMap.has(gid)) sampleMap.set(gid, []);
    const arr = sampleMap.get(gid);
    if (arr.length < 4) arr.push(a.intern_name || a.deliverer_name || `Artikel ${a.id}`);
  }
  const articleGroupSamples = [...sampleMap.entries()].sort((a,b)=>a[0]-b[0]).map(([id,samples])=>({id,samples}));

  return {
    contacts: allowedContacts,
    candidateArticles,
    diagnostics: {
      configuredContactGroups: CONTACT_GROUP_NAMES,
      foundContactGroups: (contactGroups || []).filter(g => allowedContactGroupIds.has(Number(g.id))).map(g => g.name),
      configuredContactBranches: CONTACT_BRANCH_NAMES,
      foundContactBranches: (contactBranches || []).filter(b => allowedContactBranchIds.has(Number(b.id))).map(b => b.name),
      allContactGroups: (contactGroups || []).map(g => ({id:Number(g.id), name:g.name || ''})),
      allContactBranches: (contactBranches || []).map(b => ({id:Number(b.id), name:b.name || ''})),
      configuredContactGroupIds: CONTACT_GROUP_IDS,
      configuredContactBranchIds: CONTACT_BRANCH_IDS,
      configuredArticleGroups: ARTICLE_GROUP_NAMES,
      configuredArticleGroupIds: ARTICLE_GROUP_IDS,
      productGroupSetupRequired: ARTICLE_GROUP_IDS.length === 0,
      articleGroupSamples
    }
  };
}

async function productPreferences() {
  const r = await pool.query('SELECT article_id,enabled,display_name,sort_order FROM product_visibility');
  return new Map(r.rows.map(x => [Number(x.article_id), x]));
}

async function catalog() {
  const base = await fetchBexioCatalogBase();
  const prefs = await productPreferences();
  const filterConfigured = prefs.size > 0;
  const articles = base.candidateArticles
    .filter(a => !filterConfigured || prefs.get(Number(a.id))?.enabled === true)
    .map(a => ({
      ...a,
      name: prefs.get(Number(a.id))?.display_name?.trim() || a.name,
      sort_order: Number(prefs.get(Number(a.id))?.sort_order || 0)
    }))
    .sort((a,b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name, 'de'));

  return {
    contacts: base.contacts,
    articles,
    diagnostics: {
      ...base.diagnostics,
      productVisibilityConfigured: filterConfigured,
      visibleProductCount: articles.length,
      candidateProductCount: base.candidateArticles.length
    }
  };
}

function monthTitle(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`);
  const month = new Intl.DateTimeFormat('de-CH', { month: 'long' }).format(d);
  return ORDER_TITLE_TEMPLATE.replace('{month}', month).replace('{year}', String(d.getFullYear()));
}

function orderCreatePayloadFrom(source, contactId, title, dateStr) {
  const fields = [
    'user_id','logopaper_id','language_id','bank_account_id','currency_id','payment_type_id',
    'header','footer','mwst_type','mwst_is_net','show_position_taxes','contact_sub_id','pr_project_id',
    'contact_address_manual','template_slug'
  ];
  const body = { title, contact_id: contactId, is_valid_from: dateStr };
  for (const f of fields) if (source?.[f] !== undefined && source?.[f] !== null) body[f] = source[f];
  return body;
}

async function findOrCreateMonthlyOrder(contactId, dateStr) {
  const title = monthTitle(dateStr);
  const orders = await paged('/2.0/kb_order?order_by=updated_at_desc');
  const sameContact = orders.filter(o => Number(o.contact_id) === Number(contactId));
  const exact = sameContact.find(o => norm(o.title) === norm(title));
  if (exact) return exact;
  if (!AUTO_CREATE_ORDER) throw new Error(`Kein Auftrag „${title}“ gefunden.`);
  const sourceSummary = sameContact[0];
  if (!sourceSummary) throw new Error('Für diesen Kunden existiert noch kein Auftrag, dessen Einstellungen als Vorlage verwendet werden können. Einmalig einen Musterauftrag in bexio anlegen.');
  const source = await bexio(`/2.0/kb_order/${sourceSummary.id}`);
  const payload = orderCreatePayloadFrom(source, contactId, title, dateStr);
  return bexio('/2.0/kb_order', { method: 'POST', body: JSON.stringify(payload) });
}

async function createArticlePosition(orderId, article, qty) {
  const required = ['unit_id','account_id','tax_id','sale_price'];
  for (const f of required) if (article[f] === null || article[f] === undefined || article[f] === '') {
    throw new Error(`Artikel „${article.name}“ hat in bexio kein ${f}. Bitte Stammdaten prüfen.`);
  }
  const amount = Number(qty).toFixed(6);
  return bexio(`/2.0/kb_order/${orderId}/kb_position_article`, {
    method: 'POST', body: JSON.stringify({
      amount,
      unit_id: Number(article.unit_id),
      account_id: Number(article.account_id),
      tax_id: Number(article.tax_id),
      text: article.name,
      unit_price: Number(article.sale_price).toFixed(6),
      discount_in_percent: '0.000000',
      is_optional: false,
      article_id: Number(article.id)
    })
  });
}

async function processDraft(req, draftId) {
  if (!UUID_RE.test(String(draftId))) throw new Error('Ungültige Bestellungs-ID.');
  await releaseStaleProcessing();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const lock = await client.query('SELECT * FROM draft_orders WHERE id=$1 FOR UPDATE', [draftId]);
    if (!lock.rowCount) throw new Error('Bestellung nicht gefunden.');
    const draft = lock.rows[0];
    if (draft.status === 'created') { await client.query('COMMIT'); return draft; }
    if (!['draft','failed'].includes(draft.status)) {
      throw new Error(draft.status === 'processing'
        ? 'Bestellung wird gerade verarbeitet. Bitte kurz warten und die Liste aktualisieren.'
        : `Bestellung ist im Status ${draft.status}.`);
    }
    await client.query("UPDATE draft_orders SET status='processing',error_message=NULL,updated_at=now() WHERE id=$1", [draftId]);
    await client.query('COMMIT');
  } catch (err) {
    // Offene Transaktion immer beenden, sonst geht die Verbindung mit gehaltener
    // Zeilensperre zurück in den Pool.
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally { client.release(); }

  try {
    let orderRow = (await pool.query('SELECT * FROM draft_orders WHERE id=$1', [draftId])).rows[0];
    let itemRows = (await pool.query('SELECT * FROM draft_order_items WHERE draft_order_id=$1 ORDER BY id', [draftId])).rows;
    if (!itemRows.length) throw new Error('Bestellung enthält keine Positionen.');

    if (DRY_RUN) {
      await sleep(250);
      const fakeNr = `TEST-LS-${String(Date.now()).slice(-6)}`;
      await pool.query("UPDATE draft_orders SET status='created',bexio_delivery_nr=$2,updated_at=now() WHERE id=$1", [draftId, fakeNr]);
      await audit(req, 'delivery.create.dryrun', 'draft_order', draftId, { delivery_nr: fakeNr });
      return (await pool.query('SELECT * FROM draft_orders WHERE id=$1', [draftId])).rows[0];
    }

    const cat = await catalog();
    const articleMap = new Map(cat.articles.map(a => [Number(a.id), a]));
    const dateStr = typeof orderRow.delivery_date === 'string' ? orderRow.delivery_date.slice(0,10) : orderRow.delivery_date.toISOString().slice(0,10);
    const displayDate = new Intl.DateTimeFormat('de-CH').format(new Date(`${dateStr}T12:00:00`));

    // 1) Monatsauftrag bestimmen. Seine ID wird sofort lokal gespeichert, damit ein Retry
    // denselben Auftrag weiterverwendet und nicht erneut sucht/erstellt.
    let order;
    if (orderRow.bexio_order_id) {
      order = await bexio(`/2.0/kb_order/${orderRow.bexio_order_id}`);
    } else {
      order = await findOrCreateMonthlyOrder(orderRow.contact_id, dateStr);
      await pool.query(
        'UPDATE draft_orders SET bexio_order_id=$2,bexio_order_nr=$3,updated_at=now() WHERE id=$1',
        [draftId, order.id, order.document_nr]
      );
      orderRow.bexio_order_id = order.id;
      orderRow.bexio_order_nr = order.document_nr;
    }

    // 2) Textposition nur EINMAL anlegen und ihre ID sofort speichern. Dadurch bleibt die
    // gewünschte Reihenfolge "Lieferdatum/LS -> Produktpositionen" erhalten, aber ein Retry
    // erzeugt keine zweite Textzeile mehr.
    if (!orderRow.bexio_text_position_id) {
      const textPos = await bexio(`/2.0/kb_order/${order.id}/kb_position_text`, {
        method: 'POST', body: JSON.stringify({ text: `${displayDate} Lieferung …`, show_pos_nr: false })
      });
      await pool.query(
        'UPDATE draft_orders SET bexio_text_position_id=$2,updated_at=now() WHERE id=$1',
        [draftId, textPos.id]
      );
      orderRow.bexio_text_position_id = textPos.id;
    }

    // 3) Produktpositionen ebenfalls idempotent anlegen: bereits gespeicherte Positionen
    // werden bei einem Retry wiederverwendet statt nochmals in den Auftrag geschrieben.
    const deliveryPositions = [];
    for (const item of itemRows) {
      let positionId = item.bexio_position_id ? Number(item.bexio_position_id) : null;
      if (!positionId) {
        const article = articleMap.get(Number(item.article_id));
        if (!article) throw new Error(`Artikel ${item.article_id} ist nicht mehr in einer freigegebenen Artikelgruppe.`);
        const position = await createArticlePosition(order.id, article, item.quantity);
        positionId = Number(position.id);
        await pool.query('UPDATE draft_order_items SET bexio_position_id=$2 WHERE id=$1', [item.id, positionId]);
      }
      deliveryPositions.push({ id: positionId, type: 'KbPositionArticle', amount: Number(item.quantity) });
    }

    // 4) Lieferschein nur EINMAL erstellen und die ID sofort speichern. Wenn nach diesem
    // Schritt ein späterer API-Aufruf fehlschlägt, setzt ein Retry beim vorhandenen
    // Lieferschein fort und erzeugt keinen zweiten.
    orderRow = (await pool.query('SELECT * FROM draft_orders WHERE id=$1', [draftId])).rows[0];
    let delivery;
    if (orderRow.bexio_delivery_id) {
      delivery = await bexio(`/2.0/kb_delivery/${orderRow.bexio_delivery_id}`);
    } else {
      delivery = await bexio(`/2.0/kb_order/${order.id}/delivery`, {
        method: 'POST', body: JSON.stringify({ positions: deliveryPositions })
      });
      await pool.query(
        `UPDATE draft_orders
         SET bexio_delivery_id=$2,bexio_delivery_nr=$3,updated_at=now()
         WHERE id=$1`,
        [draftId, delivery.id, delivery.document_nr || null]
      );
      orderRow.bexio_delivery_id = delivery.id;
      orderRow.bexio_delivery_nr = delivery.document_nr || null;
    }

    // 5) Ausstellen nur solange es lokal noch nicht als erfolgreich markiert wurde.
    if (!orderRow.bexio_delivery_issued) {
      await bexio(`/2.0/kb_delivery/${delivery.id}/issue`, { method: 'POST' });
      await pool.query(
        'UPDATE draft_orders SET bexio_delivery_issued=true,updated_at=now() WHERE id=$1',
        [draftId]
      );
    }

    // Nach dem Ausstellen nochmals laden, damit document_nr sicher aktuell ist.
    delivery = await bexio(`/2.0/kb_delivery/${delivery.id}`);
    const deliveryNr = delivery.document_nr || orderRow.bexio_delivery_nr;
    if (!deliveryNr) throw new Error('bexio hat keine Lieferscheinnummer zurückgegeben.');

    // 6) Dieselbe Textposition auf die definitive Nummer aktualisieren.
    const finalText = `${displayDate} Lieferung ${deliveryNr}`;
    await bexio(`/2.0/kb_order/${order.id}/kb_position_text/${orderRow.bexio_text_position_id}`, {
      method: 'POST', body: JSON.stringify({ text: finalText, show_pos_nr: false })
    });

    await pool.query(
      `UPDATE draft_orders
       SET status='created',bexio_order_id=$2,bexio_order_nr=$3,bexio_delivery_id=$4,bexio_delivery_nr=$5,error_message=NULL,updated_at=now()
       WHERE id=$1`,
      [draftId, order.id, order.document_nr, delivery.id, deliveryNr]
    );
    await audit(req, 'delivery.create', 'draft_order', draftId, { order_id: order.id, order_nr: order.document_nr, delivery_id: delivery.id, delivery_nr: deliveryNr });
    return (await pool.query('SELECT * FROM draft_orders WHERE id=$1', [draftId])).rows[0];
  } catch (err) {
    await pool.query("UPDATE draft_orders SET status='failed',error_message=$2,updated_at=now() WHERE id=$1", [draftId, String(err.message).slice(0,2000)]);
    await audit(req, 'delivery.create.failed', 'draft_order', draftId, { error: String(err.message).slice(0,500) });
    throw err;
  }
}

app.get('/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, dryRun: DRY_RUN }); }
  catch { res.status(503).json({ ok: false }); }
});



app.get('/password-reset', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!PASSWORD_RESET_TOKEN || PASSWORD_RESET_TOKEN.length < 24) {
    return res.status(404).send(resetPage('Passwort-Reset ist derzeit nicht aktiviert.', true));
  }
  res.send(resetPage());
});

app.post('/password-reset', authLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!PASSWORD_RESET_TOKEN || PASSWORD_RESET_TOKEN.length < 24) {
    return res.status(404).send(resetPage('Passwort-Reset ist derzeit nicht aktiviert.', true));
  }
  const username = String(req.body?.username || '').trim();
  const token = String(req.body?.token || '');
  const password = normalizePassword(req.body?.password);
  const passwordConfirm = normalizePassword(req.body?.passwordConfirm);
  if (!secureTokenEqual(token, PASSWORD_RESET_TOKEN)) {
    await audit(req, 'password_reset.failed', 'user', username || null, { reason: 'invalid_token' });
    return res.status(403).send(resetPage('Reset-Code ist ungültig.', true));
  }
  if (password.length < 12) return res.status(422).send(resetPage('Das neue Passwort muss mindestens 12 Zeichen lang sein.', true));
  if (password !== passwordConfirm) return res.status(422).send(resetPage('Die Passwörter stimmen nicht überein.', true));
  try {
    const user = await pool.query("SELECT id,username FROM app_users WHERE lower(username)=lower($1) AND role='admin' AND active=true", [username]);
    if (!user.rowCount) {
      await audit(req, 'password_reset.failed', 'user', username || null, { reason: 'user_not_found' });
      return res.status(404).send(resetPage('Aktiver Admin-Benutzer nicht gefunden.', true));
    }
    const passwordHash = await bcrypt.hash(password, 12);
    await pool.query('UPDATE app_users SET password_hash=$1 WHERE id=$2', [passwordHash, user.rows[0].id]);
    // Alle bestehenden Sessions ungültig machen. Danach ist eine neue Anmeldung nötig.
    try { await pool.query('DELETE FROM user_sessions'); } catch (e) { console.error('Session cleanup error:', e.message); }
    await audit(req, 'password_reset.success', 'user', user.rows[0].id);
    return res.send(resetPage('Passwort wurde geändert. Lösche jetzt PASSWORD_RESET_TOKEN in Render und melde dich mit dem neuen Passwort an.'));
  } catch (e) {
    console.error('Password reset error:', e);
    return res.status(500).send(resetPage('Passwort konnte nicht zurückgesetzt werden.', true));
  }
});



app.get('/login-recovery', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!LOGIN_RECOVERY_TOKEN || LOGIN_RECOVERY_TOKEN.length < 24) {
    return res.status(404).send(loginRecoveryPage('Login-Wiederherstellung ist derzeit nicht aktiviert.', true));
  }
  res.send(loginRecoveryPage());
});

app.post('/login-recovery', authLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!LOGIN_RECOVERY_TOKEN || LOGIN_RECOVERY_TOKEN.length < 24) {
    return res.status(404).send(loginRecoveryPage('Login-Wiederherstellung ist derzeit nicht aktiviert.', true));
  }
  const token = String(req.body?.token || '');
  const username = String(req.body?.username || '').trim();
  const password = normalizePassword(req.body?.password);
  const passwordConfirm = normalizePassword(req.body?.passwordConfirm);
  if (!secureTokenEqual(token, LOGIN_RECOVERY_TOKEN)) {
    await audit(req, 'login_recovery.failed', 'user', null, { reason: 'invalid_token' });
    return res.status(403).send(loginRecoveryPage('Wiederherstellungs-Code ist ungültig.', true));
  }
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
    return res.status(422).send(loginRecoveryPage('Benutzername: 3–64 Zeichen, nur Buchstaben, Zahlen, Punkt, Unterstrich oder Bindestrich.', true));
  }
  if (password.length < 12) return res.status(422).send(loginRecoveryPage('Das neue Passwort muss mindestens 12 Zeichen lang sein.', true));
  if (password !== passwordConfirm) return res.status(422).send(loginRecoveryPage('Die Passwörter stimmen nicht überein.', true));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE app_users IN EXCLUSIVE MODE');
    const admin = await client.query("SELECT id FROM app_users WHERE role='admin' ORDER BY active DESC, id ASC LIMIT 1");
    const conflict = await client.query('SELECT id FROM app_users WHERE lower(username)=lower($1)', [username]);
    if (conflict.rowCount && (!admin.rowCount || conflict.rows[0].id !== admin.rows[0].id)) {
      await client.query('ROLLBACK');
      return res.status(409).send(loginRecoveryPage('Dieser Benutzername wird bereits von einem anderen Konto verwendet.', true));
    }
    const passwordHash = await bcrypt.hash(password, 12);
    let adminId;
    if (admin.rowCount) {
      adminId = admin.rows[0].id;
      await client.query("UPDATE app_users SET username=$1,password_hash=$2,role='admin',active=true WHERE id=$3", [username, passwordHash, adminId]);
    } else {
      const created = await client.query("INSERT INTO app_users(username,password_hash,role,active) VALUES($1,$2,'admin',true) RETURNING id", [username, passwordHash]);
      adminId = created.rows[0].id;
    }
    await client.query('COMMIT');
    try { await pool.query('DELETE FROM user_sessions'); } catch (e) { console.error('Session cleanup error:', e.message); }
    await audit(req, 'login_recovery.success', 'user', adminId, { username });
    return res.send(loginRecoveryPage('Admin-Login wurde neu angelegt. Lösche jetzt LOGIN_RECOVERY_TOKEN in Render und melde dich mit dem neuen Benutzernamen und Passwort an.'));
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('Login recovery error:', e);
    return res.status(500).send(loginRecoveryPage('Admin-Login konnte nicht neu angelegt werden.', true));
  } finally {
    client.release();
  }
});

app.get('/api/setup/status', async (req, res) => {
  try { res.json({ setupRequired: !(await hasAnyUser()) }); }
  catch { res.status(500).json({ error: 'Setup-Status konnte nicht geprüft werden.' }); }
});

app.post('/api/setup', authLimiter, async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = normalizePassword(req.body?.password);
  const passwordConfirm = normalizePassword(req.body?.passwordConfirm);
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
    return res.status(422).json({ error: 'Benutzername: 3–64 Zeichen, nur Buchstaben, Zahlen, Punkt, Unterstrich oder Bindestrich.' });
  }
  if (password.length < 12) return res.status(422).json({ error: 'Das Passwort muss mindestens 12 Zeichen lang sein.' });
  if (password !== passwordConfirm) return res.status(422).json({ error: 'Die Passwörter stimmen nicht überein.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE app_users IN EXCLUSIVE MODE');
    const exists = await client.query('SELECT 1 FROM app_users LIMIT 1');
    if (exists.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Die Ersteinrichtung wurde bereits abgeschlossen.' });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const created = await client.query(
      'INSERT INTO app_users(username,password_hash,role) VALUES($1,$2,$3) RETURNING id,username,role',
      [username, passwordHash, 'admin']
    );
    await client.query('COMMIT');

    req.session.regenerate(async err => {
      if (err) return res.status(500).json({ error: 'Admin wurde erstellt, Anmeldung aber nicht gestartet. Bitte normal anmelden.' });
      req.session.user = created.rows[0];
      const csrf = issueCsrf(req);
      await audit(req, 'setup.admin_created', 'user', created.rows[0].id); // audit() fängt eigene Fehler ab
      res.status(201).json({ ok: true, user: req.session.user, csrf });
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error(e);
    res.status(500).json({ error: 'Admin-Konto konnte nicht erstellt werden.' });
  } finally {
    client.release();
  }
});

app.post('/api/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const loginName = String(username || '').trim();
  const loginPassword = normalizePassword(password);
  const r = await pool.query('SELECT * FROM app_users WHERE lower(username)=lower($1) AND active=true', [loginName]);
  if (!r.rowCount || !(await bcrypt.compare(loginPassword, r.rows[0].password_hash))) {
    await audit(req, 'login.failed', 'user', username || null);
    return res.status(401).json({ error: 'Benutzername oder Passwort falsch.' });
  }

  const user = { id: r.rows[0].id, username: r.rows[0].username, role: r.rows[0].role };

  req.session.regenerate(async err => {
    if (err) return res.status(500).json({ error: 'Session konnte nicht erstellt werden.' });
    req.session.user = user;
    const csrf = issueCsrf(req);
    try { await pool.query('UPDATE app_users SET last_login_at=now() WHERE id=$1', [user.id]); }
    catch (e) { console.error('last_login_at konnte nicht gespeichert werden:', e.message); }
    await audit(req, 'login.success', 'user', user.id);
    res.json({ ok: true, user: req.session.user, csrf });
  });
});

app.post('/api/logout', requireLogin, requireCsrf, async (req, res) => {
  await audit(req, 'logout');
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/session', async (req, res) => {
  if (!req.session?.user?.id) return res.json({ authenticated: false });
  res.json({ authenticated: true, user: req.session.user, csrf: issueCsrf(req), dryRun: DRY_RUN });
});

app.get('/auth/bexio/start', async (req, res) => {
  if (!req.session?.user?.id) return res.redirect('/');
  if (!BEXIO_CLIENT_ID || !BEXIO_CLIENT_SECRET) return res.status(500).send('BEXIO_CLIENT_ID/BEXIO_CLIENT_SECRET fehlen.');
  const state = crypto.randomBytes(24).toString('hex');
  req.session.bexioState = state;
  const q = new URLSearchParams({
    client_id: BEXIO_CLIENT_ID,
    redirect_uri: BEXIO_REDIRECT_URI,
    response_type: 'code',
    scope: BEXIO_SCOPES,
    state
  });
  res.redirect(`https://auth.bexio.com/realms/bexio/protocol/openid-connect/auth?${q}`);
});

app.get('/auth/bexio/callback', async (req, res) => {
  try {
    if (!req.session?.user?.id) throw new Error('Nicht angemeldet.');
    if (!req.query.state || req.query.state !== req.session.bexioState) throw new Error('OAuth-State ungültig.');
    if (!req.query.code) throw new Error('Authorization Code fehlt.');
    delete req.session.bexioState;
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code: String(req.query.code),
      client_id: BEXIO_CLIENT_ID,
      client_secret: BEXIO_CLIENT_SECRET,
      redirect_uri: BEXIO_REDIRECT_URI
    });
    const r = await fetch('https://auth.bexio.com/realms/bexio/protocol/openid-connect/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body
    });
    if (!r.ok) throw new Error(`Token-Austausch fehlgeschlagen (${r.status}).`);
    const tokens = await r.json();
    tokens.obtained_at = Date.now();
    await saveTokens(tokens);
    await audit(req, 'bexio.connected');
    res.redirect('/?bexio=connected');
  } catch (e) {
    console.error(e);
    res.status(400).send(`bexio-Verbindung fehlgeschlagen: ${escapeHtml(e.message)}`);
  }
});

app.get('/api/bexio/status', requireLogin, async (req, res) => {
  const t = await getTokens();
  res.json({ connected: !!t?.access_token, dryRun: DRY_RUN });
});

app.get('/api/catalog', requireLogin, async (req, res) => {
  try { res.json(await catalog()); }
  catch (e) { res.status(502).json({ error: e.message }); }
});


app.get('/api/admin/products', requireLogin, requireAdmin, async (req, res) => {
  try {
    const base = await fetchBexioCatalogBase();
    const prefs = await productPreferences();
    const configured = prefs.size > 0;
    const products = base.candidateArticles.map(a => {
      const pref = prefs.get(Number(a.id));
      return {
        ...a,
        enabled: configured ? pref?.enabled === true : true,
        display_name: pref?.display_name || '',
        sort_order: Number(pref?.sort_order || 0)
      };
    }).sort((a,b) => (a.sort_order - b.sort_order) || a.name.localeCompare(b.name, 'de'));
    res.json({ configured, products });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.post('/api/admin/products', requireLogin, requireAdmin, requireCsrf, async (req, res) => {
  const products = Array.isArray(req.body?.products) ? req.body.products : null;
  if (!products || products.length > 5000) return res.status(422).json({ error: 'Ungültige Produktliste.' });

  const base = await fetchBexioCatalogBase();
  const validIds = new Set(base.candidateArticles.map(a => Number(a.id)));
  const clean = [];
  const seen = new Set();
  for (const p of products) {
    const articleId = Number(p?.article_id);
    if (!Number.isFinite(articleId) || !validIds.has(articleId) || seen.has(articleId)) continue;
    seen.add(articleId);
    clean.push({
      articleId,
      enabled: p?.enabled === true,
      displayName: String(p?.display_name || '').trim().slice(0, 250) || null,
      sortOrder: Math.max(-100000, Math.min(100000, Number.isFinite(Number(p?.sort_order)) ? Math.trunc(Number(p.sort_order)) : 0))
    });
  }
  if (!clean.length) return res.status(422).json({ error: 'Keine gültigen Produkte übermittelt.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM product_visibility');
    for (const p of clean) {
      await client.query(
        `INSERT INTO product_visibility(article_id,enabled,display_name,sort_order,updated_by,updated_at)
         VALUES($1,$2,$3,$4,$5,now())`,
        [p.articleId, p.enabled, p.displayName, p.sortOrder, req.session.user.id]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  await audit(req, 'settings.products.update', 'product_visibility', null, {
    total: clean.length,
    enabled: clean.filter(x => x.enabled).length
  });
  res.json({ ok: true, enabled: clean.filter(x => x.enabled).length, total: clean.length });
});

app.get('/api/drafts', requireLogin, async (req, res) => {
  await releaseStaleProcessing();
  const r = await pool.query(`
    SELECT d.*, COALESCE(json_agg(json_build_object('id',i.id,'article_id',i.article_id,'article_name',i.article_name,'quantity',i.quantity,'unit_name',i.unit_name,'unit_price',i.unit_price) ORDER BY i.id)
      FILTER (WHERE i.id IS NOT NULL), '[]') AS items
    FROM draft_orders d LEFT JOIN draft_order_items i ON i.draft_order_id=d.id
    WHERE d.created_at > now() - interval '60 days' AND d.archived_at IS NULL
    GROUP BY d.id ORDER BY d.created_at DESC LIMIT 200
  `);
  res.json(r.rows);
});

app.post('/api/drafts', requireLogin, requireCsrf, async (req, res) => {
  const contactId = safeNumber(req.body?.contact_id);
  const deliveryDate = String(req.body?.delivery_date || zurichToday());
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  // Vom Browser pro Erfassung erzeugter Schlüssel: ein Doppelklick oder eine wiederholte
  // Anfrage mit demselben Schlüssel legt keine zweite Bestellung an.
  const clientKey = UUID_RE.test(String(req.body?.client_key || '')) ? String(req.body.client_key).toLowerCase() : null;
  if (!contactId || !/^\d{4}-\d{2}-\d{2}$/.test(deliveryDate)) return res.status(422).json({ error: 'Kunde oder Lieferdatum ungültig.' });
  if (!items.length || items.length > 100) return res.status(422).json({ error: 'Mindestens eine und höchstens 100 Positionen.' });
  if (clientKey) {
    const idemExisting = crypto.createHash('sha256').update(`client:${clientKey}`).digest('hex');
    const dup = await pool.query('SELECT id FROM draft_orders WHERE idempotency_key=$1', [idemExisting]);
    if (dup.rowCount) return res.status(200).json({ id: dup.rows[0].id, duplicate: true });
  }
  const cat = await catalog();
  const contact = cat.contacts.find(c => Number(c.id) === Number(contactId));
  if (!contact) return res.status(422).json({ error: 'Dieser Kunde gehört nicht zu einer freigegebenen Kundengruppe.' });
  // Name aus bexio übernehmen, nicht aus dem Browser.
  const contactName = String(contact.name || req.body?.contact_name || '').trim().slice(0,250) || `Kontakt ${contactId}`;
  const amap = new Map(cat.articles.map(a => [Number(a.id), a]));
  const clean = [];
  for (const item of items) {
    const article = amap.get(Number(item.article_id));
    const qty = Number(item.quantity);
    if (!article || !Number.isFinite(qty) || qty <= 0 || qty > 100000) return res.status(422).json({ error: 'Ungültiger Artikel oder Menge.' });
    clean.push({ article, qty });
  }
  const id = uuid();
  const idem = clientKey
    ? crypto.createHash('sha256').update(`client:${clientKey}`).digest('hex')
    : crypto.createHash('sha256').update(`${id}:${contactId}:${deliveryDate}`).digest('hex');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO draft_orders(id,contact_id,contact_name,delivery_date,idempotency_key,created_by)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [id, contactId, contactName, deliveryDate, idem, req.session.user.id]
    );
    if (!inserted.rowCount) {
      // Parallel eingetroffene Doppelanfrage: bestehende Bestellung zurückgeben.
      await client.query('ROLLBACK');
      const existing = await pool.query('SELECT id FROM draft_orders WHERE idempotency_key=$1', [idem]);
      return res.status(200).json({ id: existing.rows[0]?.id, duplicate: true });
    }
    for (const { article, qty } of clean) {
      await client.query(
        'INSERT INTO draft_order_items(draft_order_id,article_id,article_name,quantity,unit_name,unit_price) VALUES($1,$2,$3,$4,$5,$6)',
        [id, article.id, article.name, qty, article.unit_name || '', Number(article.sale_price || 0)]
      );
    }
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
  await audit(req, 'draft.create', 'draft_order', id, { contact_id: contactId, item_count: clean.length });
  res.status(201).json({ id });
});

app.delete('/api/drafts/:id', requireLogin, requireCsrf, async (req, res) => {
  const found = await pool.query('SELECT id,status,bexio_delivery_id,bexio_delivery_nr FROM draft_orders WHERE id=$1 AND archived_at IS NULL', [req.params.id]);
  if (!found.rowCount) return res.status(404).json({ error: 'Bestellung nicht gefunden oder bereits entfernt.' });
  const d = found.rows[0];
  await pool.query('UPDATE draft_orders SET archived_at=now(),updated_at=now() WHERE id=$1', [req.params.id]);
  await audit(req, 'draft.archive', 'draft_order', req.params.id, { status: d.status, bexio_delivery_id: d.bexio_delivery_id, bexio_delivery_nr: d.bexio_delivery_nr });
  res.json({ ok: true, bexio_unchanged: Boolean(d.bexio_delivery_id || d.bexio_delivery_nr) });
});

app.post('/api/drafts/archive-all', requireLogin, requireCsrf, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 200) : [];
  const valid = ids.filter(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id));
  if (!valid.length) return res.status(422).json({ error: 'Keine sichtbaren Bestellungen zum Archivieren.' });
  const result = await pool.query(
    'UPDATE draft_orders SET archived_at=now(),updated_at=now() WHERE id = ANY($1::uuid[]) AND archived_at IS NULL RETURNING id,status,bexio_delivery_nr',
    [valid]
  );
  await audit(req, 'draft.archive_all_visible', 'draft_order', null, { count: result.rowCount, ids: result.rows.map(r => r.id) });
  res.json({ ok: true, archived: result.rowCount });
});

app.post('/api/drafts/:id/process', requireLogin, requireCsrf, async (req, res) => {
  try { res.json(await processDraft(req, req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/drafts/process-all', requireLogin, requireCsrf, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0,100) : [];
  if (!ids.length) return res.status(422).json({ error: 'Keine Bestellungen ausgewählt.' });
  const results = [];
  for (const id of ids) {
    try { const d = await processDraft(req, String(id)); results.push({ id, ok: true, delivery_nr: d.bexio_delivery_nr }); }
    catch (e) { results.push({ id, ok: false, error: e.message }); }
  }
  res.json({ results });
});


function monthRange(rawMonth) {
  const month = /^\d{4}-\d{2}$/.test(String(rawMonth || '')) ? String(rawMonth) : zurichToday().slice(0,7);
  const [y, m] = month.split('-').map(Number);
  if (!y || m < 1 || m > 12) throw new Error('Ungültiger Monat.');
  const start = `${month}-01`;
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2,'0')}-01`;
  return { month, start, next };
}

app.get('/api/reporting/monthly', requireLogin, async (req, res) => {
  try {
    const { month, start, next } = monthRange(req.query.month);

    // Aktuelle bexio-Preise dienen nur als Fallback für ältere Portal-Einträge,
    // die vor v1.15 noch keinen Preis-Snapshot gespeichert hatten.
    let currentPriceMap = new Map();
    try {
      const cat = await catalog();
      currentPriceMap = new Map((cat.articles || []).map(a => [Number(a.id), Number(a.sale_price || 0)]));
    } catch (_) {}

    const delivered = await pool.query(`
      SELECT d.id,d.contact_id,d.contact_name,d.delivery_date,d.bexio_delivery_nr,
             i.id AS item_id,i.article_id,i.article_name,i.quantity,i.unit_name,i.unit_price
      FROM draft_orders d
      JOIN draft_order_items i ON i.draft_order_id=d.id
      WHERE d.status='created'
        AND d.delivery_date >= $1::date AND d.delivery_date < $2::date
      ORDER BY d.delivery_date,d.contact_name,i.id
    `, [start, next]);

    const manual = await pool.query(`
      SELECT id,sale_date,category,amount_chf,note,article_id,article_name,quantity,unit_name,
             salesperson,cash_chf,twint_chf,created_at
      FROM manual_sales
      WHERE sale_date >= $1::date AND sale_date < $2::date
      ORDER BY sale_date,created_at
    `, [start, next]);

    const customerMap = new Map();
    const productMap = new Map();
    let bexioRevenue = 0;
    let kgTotal = 0;
    let estimatedLegacyItems = 0;

    for (const r of delivered.rows) {
      let unitPrice = r.unit_price == null ? null : Number(r.unit_price);
      if (unitPrice == null || !Number.isFinite(unitPrice)) {
        unitPrice = currentPriceMap.get(Number(r.article_id)) || 0;
        estimatedLegacyItems += 1;
      }
      const qty = Number(r.quantity || 0);
      const revenue = qty * unitPrice;
      bexioRevenue += revenue;

      const ckey = String(r.contact_id || r.contact_name);
      const c = customerMap.get(ckey) || { contact_id:r.contact_id, name:r.contact_name, revenue:0, kg:0, deliveries:new Set(), products:new Map() };
      c.revenue += revenue;
      if (norm(r.unit_name) === 'kg') c.kg += qty;
      if (r.bexio_delivery_nr) c.deliveries.add(r.bexio_delivery_nr);
      const cp = c.products.get(r.article_name) || { name:r.article_name, quantity:0, unit:r.unit_name || '', revenue:0 };
      cp.quantity += qty; cp.revenue += revenue;
      c.products.set(r.article_name, cp);
      customerMap.set(ckey, c);

      const pkey = String(r.article_id || r.article_name);
      const p = productMap.get(pkey) || { article_id:r.article_id, name:r.article_name, quantity:0, unit:r.unit_name || '', revenue:0, customers:new Set(), manual_quantity:0 };
      p.quantity += qty;
      p.revenue += revenue;
      p.customers.add(r.contact_name);
      productMap.set(pkey, p);
      if (norm(r.unit_name) === 'kg') kgTotal += qty;
    }

    let manualRevenue = 0;
    for (const r of manual.rows) {
      const amount = Number(r.amount_chf || 0);
      manualRevenue += amount;
      const qty = Number(r.quantity || 0);
      if (r.article_name && qty > 0) {
        const pkey = String(r.article_id || `manual:${r.article_name}`);
        const p = productMap.get(pkey) || { article_id:r.article_id, name:r.article_name, quantity:0, unit:r.unit_name || '', revenue:0, customers:new Set(), manual_quantity:0 };
        p.quantity += qty;
        p.manual_quantity += qty;
        productMap.set(pkey, p);
        if (norm(r.unit_name) === 'kg') kgTotal += qty;
      }
    }

    const customers = [...customerMap.values()].map(c => ({
      contact_id:c.contact_id,
      name:c.name,
      revenue:Number(c.revenue.toFixed(2)),
      kg:Number(c.kg.toFixed(3)),
      deliveries:c.deliveries.size,
      products:[...c.products.values()].map(p => ({
        ...p,
        quantity:Number(p.quantity.toFixed(3)),
        revenue:Number(p.revenue.toFixed(2))
      })).sort((a,b)=>b.quantity-a.quantity)
    })).sort((a,b)=>b.revenue-a.revenue);

    const products = [...productMap.values()].map(p => ({
      article_id:p.article_id,
      name:p.name,
      quantity:Number(p.quantity.toFixed(3)),
      unit:p.unit,
      revenue:Number(p.revenue.toFixed(2)),
      customers:p.customers.size,
      manual_quantity:Number((p.manual_quantity || 0).toFixed(3))
    })).sort((a,b)=> {
      if (norm(a.unit)==='kg' && norm(b.unit)!=='kg') return -1;
      if (norm(a.unit)!=='kg' && norm(b.unit)==='kg') return 1;
      return b.quantity-a.quantity;
    });


    // Märit Bern: Lohn pro Person und Verkaufstag.
    // Tageslohn = CHF 200 bis inkl. CHF 600 Umsatz,
    // darüber 30% des Umsatzanteils über CHF 600 zusätzlich.
    // Vom Monats-Bruttolohn werden 6.4% abgezogen.
    const marketDaily = new Map();
    for (const r of manual.rows) {
      if (r.category !== 'Märit Bern' || !r.salesperson) continue;
      const person = String(r.salesperson);
      const day = String(r.sale_date).slice(0,10);
      const key = `${person}|${day}`;
      const row = marketDaily.get(key) || { salesperson:person, sale_date:day, revenue:0, cash:0, twint:0 };
      row.revenue += Number(r.amount_chf || 0);
      row.cash += Number(r.cash_chf || 0);
      row.twint += Number(r.twint_chf || 0);
      marketDaily.set(key, row);
    }

    const payrollMap = new Map();
    for (const d of marketDaily.values()) {
      const gross = 200 + Math.max(0, d.revenue - 600) * 0.30;
      const p = payrollMap.get(d.salesperson) || { salesperson:d.salesperson, days:0, revenue:0, gross_wage:0, deduction_64:0, net_wage:0, daily:[] };
      p.days += 1;
      p.revenue += d.revenue;
      p.gross_wage += gross;
      p.daily.push({
        sale_date:d.sale_date,
        revenue:Number(d.revenue.toFixed(2)),
        cash:Number(d.cash.toFixed(2)),
        twint:Number(d.twint.toFixed(2)),
        gross_wage:Number(gross.toFixed(2))
      });
      payrollMap.set(d.salesperson, p);
    }

    const market_payroll = [...payrollMap.values()].map(p => {
      const deduction = p.gross_wage * 0.064;
      return {
        salesperson:p.salesperson,
        days:p.days,
        revenue:Number(p.revenue.toFixed(2)),
        gross_wage:Number(p.gross_wage.toFixed(2)),
        deduction_64:Number(deduction.toFixed(2)),
        net_wage:Number((p.gross_wage - deduction).toFixed(2)),
        daily:p.daily.sort((a,b)=>a.sale_date.localeCompare(b.sale_date))
      };
    }).sort((a,b)=>a.salesperson.localeCompare(b.salesperson,'de-CH'));

    res.json({
      month,
      summary:{
        bexio_revenue:Number(bexioRevenue.toFixed(2)),
        manual_revenue:Number(manualRevenue.toFixed(2)),
        total_revenue:Number((bexioRevenue + manualRevenue).toFixed(2)),
        kg_total:Number(kgTotal.toFixed(3)),
        customers:customers.length,
        manual_entries:manual.rows.length,
        estimated_legacy_items:estimatedLegacyItems
      },
      customers,
      products,
      market_payroll,
      manual_sales:manual.rows.map(r => ({
        ...r,
        amount_chf:Number(r.amount_chf),
        quantity:r.quantity == null ? null : Number(r.quantity)
      }))
    });
  } catch (e) {
    res.status(500).json({ error:e.message });
  }
});

app.post('/api/manual-sales', requireLogin, requireCsrf, async (req, res) => {
  const saleDate = String(req.body?.sale_date || '').trim();
  const category = String(req.body?.category || '').trim();
  const note = String(req.body?.note || '').trim().slice(0,500) || null;
  const allowed = new Set(['TWINT','Märit Bern','Märit Thun','Bar']);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(saleDate)) return res.status(422).json({ error:'Datum ungültig.' });
  if (!allowed.has(category)) return res.status(422).json({ error:'Kategorie ungültig.' });

  let amount = 0;
  let salesperson = null;
  let cash = null;
  let twint = null;
  let articleId = null;
  let articleName = null;
  let unitName = null;
  let quantity = null;

  if (category === 'Märit Bern') {
    salesperson = String(req.body?.salesperson || '').trim();
    if (!['Victoria','Sali'].includes(salesperson)) return res.status(422).json({ error:'Bitte Victoria oder Sali auswählen.' });

    cash = Number(req.body?.cash_chf || 0);
    twint = Number(req.body?.twint_chf || 0);
    if (!Number.isFinite(cash) || cash < 0 || cash > 1000000) return res.status(422).json({ error:'Bar-Betrag ungültig.' });
    if (!Number.isFinite(twint) || twint < 0 || twint > 1000000) return res.status(422).json({ error:'TWINT-Betrag ungültig.' });
    amount = cash + twint;
    if (amount <= 0) return res.status(422).json({ error:'Bitte mindestens einen Bar- oder TWINT-Betrag eingeben.' });
  } else {
    amount = Number(req.body?.amount_chf);
    if (!Number.isFinite(amount) || amount < 0 || amount > 1000000) return res.status(422).json({ error:'Betrag ungültig.' });

    articleId = req.body?.article_id ? Number(req.body.article_id) : null;
    quantity = req.body?.quantity !== '' && req.body?.quantity != null ? Number(req.body.quantity) : null;

    if (articleId) {
      const cat = await catalog();
      const article = (cat.articles || []).find(a => Number(a.id) === articleId);
      if (!article) return res.status(422).json({ error:'Produkt ist nicht freigegeben.' });
      articleName = article.name;
      unitName = article.unit_name || '';
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100000) return res.status(422).json({ error:'Bei gewähltem Produkt bitte eine gültige Menge eingeben.' });
    } else {
      articleId = null;
      quantity = null;
    }
  }

  const id = uuid();
  await pool.query(`
    INSERT INTO manual_sales(
      id,sale_date,category,amount_chf,note,article_id,article_name,quantity,unit_name,
      salesperson,cash_chf,twint_chf,created_by
    )
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
  `, [
    id,saleDate,category,amount,note,articleId,articleName,quantity,unitName,
    salesperson,cash,twint,req.session.user.id
  ]);

  await audit(req, 'manual_sale.create', 'manual_sale', id, {
    sale_date:saleDate,category,amount_chf:amount,article_id:articleId,quantity,
    salesperson,cash_chf:cash,twint_chf:twint
  });
  res.status(201).json({ ok:true,id });
});

app.delete('/api/manual-sales/:id', requireLogin, requireCsrf, async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(String(req.params.id))) return res.status(422).json({ error:'Ungültige Buchung.' });
  const r = await pool.query('DELETE FROM manual_sales WHERE id=$1 RETURNING id,category,amount_chf,sale_date', [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error:'Buchung nicht gefunden.' });
  await audit(req, 'manual_sale.delete', 'manual_sale', req.params.id, r.rows[0]);
  res.json({ ok:true });
});


app.get('/print', async (req, res) => {
  try {
    if (!req.session?.user?.id) return res.redirect('/');

    const rawIds = String(req.query.ids || '').split(',').map(x => x.trim()).filter(Boolean).slice(0,100);
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const ids = rawIds.filter(id => uuidRe.test(id));
    if (!ids.length) return res.status(400).send('Keine gültigen Lieferscheine ausgewählt.');

    // Drafts and items are fetched separately on purpose. This avoids driver/version
    // differences around json_agg and keeps the print route robust on Render/PostgreSQL.
    const draftsResult = await pool.query(`
      SELECT *
      FROM draft_orders
      WHERE id = ANY($1::uuid[]) AND status='created'
      ORDER BY created_at
    `, [ids]);

    if (!draftsResult.rows.length) {
      return res.status(404).send('Für die Auswahl wurden keine erstellten Lieferscheine gefunden.');
    }

    const foundIds = draftsResult.rows.map(d => d.id);
    const itemsResult = await pool.query(`
      SELECT draft_order_id, article_name, quantity, unit_name, id
      FROM draft_order_items
      WHERE draft_order_id = ANY($1::uuid[])
      ORDER BY draft_order_id, id
    `, [foundIds]);

    const itemsByDraft = new Map();
    for (const item of itemsResult.rows) {
      const key = String(item.draft_order_id);
      if (!itemsByDraft.has(key)) itemsByDraft.set(key, []);
      itemsByDraft.get(key).push(item);
    }

    // Adressdaten frisch aus bexio laden, damit das Sichtfenster auf dem Ausdruck
    // ohne doppelte Stammdatenpflege korrekt befüllt wird. Fällt der Abruf aus,
    // bleibt mindestens der im Portal gespeicherte Kundenname sichtbar.
    const contactAddressMap = new Map();
    const uniqueContactIds = [...new Set(draftsResult.rows.map(d => Number(d.contact_id)).filter(Number.isFinite))];
    await Promise.all(uniqueContactIds.map(async (contactId) => {
      try {
        const c = await bexio(`/2.0/contact/${contactId}`);
        const company = [c?.name_1, c?.name_2].filter(Boolean).join(' ').trim();
        const street = String(c?.address || '').trim();
        const zipCity = [c?.postcode, c?.city].filter(Boolean).join(' ').trim();
        const lines = [company, street, zipCity].filter(Boolean);
        contactAddressMap.set(contactId, lines);
      } catch (err) {
        console.warn(`Kontaktadresse ${contactId} konnte für Druck nicht geladen werden:`, err.message);
      }
    }));

    const dateFormatter = new Intl.DateTimeFormat('de-CH');
    const pages = draftsResult.rows.map(d => {
      const items = itemsByDraft.get(String(d.id)) || [];
      let dateText = '';
      try {
        const rawDate = d.delivery_date instanceof Date
          ? d.delivery_date.toISOString().slice(0,10)
          : String(d.delivery_date || '').slice(0,10);
        const dateObj = new Date(`${rawDate}T12:00:00`);
        dateText = Number.isNaN(dateObj.getTime()) ? rawDate : dateFormatter.format(dateObj);
      } catch (_) {
        dateText = String(d.delivery_date || '');
      }

      const rows = items.map((i, idx) => `<tr><td class="pos">${idx + 1}</td><td class="product">${escapeHtml(i.article_name)}</td><td class="qty">${escapeHtml(formatQty(i.quantity))}</td><td class="unit">${escapeHtml(i.unit_name || '')}</td></tr>`).join('');
      const addressLines = contactAddressMap.get(Number(d.contact_id)) || [d.contact_name || ''];
      const addressHtml = addressLines.map((line, idx) => `<div${idx === 0 ? ' class="recipient-name"' : ''}>${escapeHtml(line)}</div>`).join('');
      return `
        <section class="sheet">
          <div class="sender">
            <div class="sender-name">fungi futuri GmbH</div>
            <div>Erlenstrasse 43</div>
            <div>3612 Steffisburg</div>
          </div>
          <div class="window-address">
            ${addressHtml}
          </div>
          <div class="document-area">
            <div class="doc-head">
              <div></div>
              <div class="doc-title">Lieferschein</div>
            </div>
            <div class="meta-grid"><div><span>Lieferscheinnummer</span><strong>${escapeHtml(d.bexio_delivery_nr || '')}</strong></div><div><span>Lieferdatum</span><strong>${escapeHtml(dateText)}</strong></div></div>
            <div class="intro">Gemäss Ihrer Bestellung liefern wir Ihnen folgende Ware:</div>
            <table class="items"><thead><tr><th class="pos">Pos.</th><th>Produkt</th><th class="qty">Menge</th><th class="unit">Einheit</th></tr></thead><tbody>${rows}</tbody></table>
            <div class="spacer"></div>
            <div class="note">Vielen Dank für Ihren Auftrag.</div>
            <footer>${DRY_RUN ? 'TESTMODUS · ' : ''}Erstellt über das bexio Lieferportal</footer>
          </div>
        </section>`;
    }).join('\n');

    res.set('Cache-Control', 'no-store');
    res.type('html').send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lieferscheine</title><style>
      @page{size:A4;margin:0}
      *{box-sizing:border-box}html,body{margin:0;padding:0}body{font-family:Arial,Helvetica,sans-serif;color:#111;background:#fff;font-size:11.5px;line-height:1.35}
      .sheet{position:relative;width:210mm;height:297mm;page-break-after:always;break-after:page;overflow:hidden}.sheet:last-child{page-break-after:auto;break-after:auto}
      .sender{position:absolute;left:32mm;top:30mm;font-size:10.5px;line-height:1.5}.sender-name{font-size:12.5px;font-weight:700;margin-bottom:.8mm}
      /* C5 Sichtfenster rechts: Empfängerblock ca. 20 mm vom rechten Blattrand,
         43 mm von oben. 85 x 43 mm bleibt innerhalb üblicher 90/100 x 45 mm Fenster. */
      .window-address{position:absolute;left:105mm;top:43mm;width:85mm;height:43mm;padding:3mm 4mm;font-size:11.5px;line-height:1.42;overflow:hidden}
      .window-address .recipient-name{font-weight:800;font-size:15px;line-height:1.25;margin-bottom:1.5mm}
      .document-area{position:absolute;left:15mm;right:15mm;top:96mm;bottom:14mm;display:flex;flex-direction:column}
      .doc-head{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:1.5px solid #111;padding-bottom:4mm}.doc-title{font-size:28px;font-weight:700}
      .meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:9mm;margin:6mm 0 8mm}.meta-grid>div{border-bottom:1px solid #aaa;padding-bottom:2.5mm}.meta-grid span{display:block;font-size:9px;text-transform:uppercase;letter-spacing:.55px;color:#666;margin-bottom:1.5mm}.meta-grid strong{font-size:13px}
      .intro{margin-bottom:5mm}
      table.items{width:100%;border-collapse:collapse;table-layout:fixed}table.items th{font-size:9px;text-transform:uppercase;letter-spacing:.45px;color:#555;border-bottom:1.5px solid #222;padding:2.5mm 1.5mm;text-align:left}table.items td{padding:3.5mm 1.5mm;border-bottom:1px solid #ddd;vertical-align:top;font-size:11.5px}.pos{width:13mm}.qty{width:23mm;text-align:right!important}.unit{width:20mm}.product{overflow-wrap:anywhere}
      .spacer{flex:1;min-height:14mm}.note{font-size:10.5px;margin-top:8mm}footer{border-top:1px solid #ddd;padding-top:2.5mm;margin-top:7mm;color:#777;font-size:9px}
      @media screen{body{background:#ececec;padding:12px}.sheet{background:#fff;margin:0 auto 16px;box-shadow:0 2px 12px rgba(0,0,0,.14)}.window-address{outline:1px dashed #79a7d8}.window-address:before{content:'C5 Sichtfenster rechts';position:absolute;right:1mm;top:-5mm;font-size:7px;color:#5e86b1}}
      @media print{body{background:#fff}.sheet{margin:0}.window-address{outline:none}}
    </style></head><body>${pages}<script src="/print.js?v=1.14"></script></body></html>`);
  } catch (err) {
    console.error('Print route failed:', err);
    if (res.headersSent) return;
    res.status(500).type('html').send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Druckfehler</title></head><body><h1>Lieferscheine konnten nicht geladen werden</h1><p>${escapeHtml(err.message || 'Unbekannter Fehler')}</p><p><a href="/">Zurück zum Lieferportal</a></p></body></html>`);
  }
});

app.get('/api/audit', requireLogin, async (req, res) => {
  if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'Nur Admin.' });
  const r = await pool.query('SELECT id,action,entity_type,entity_id,metadata,ip,created_at FROM audit_log ORDER BY created_at DESC LIMIT 200');
  res.json(r.rows);
});

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function formatQty(q) { const n = Number(q); return Number.isFinite(n) ? n.toLocaleString('de-CH', { maximumFractionDigits: 6 }) : String(q); }

app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0, etag: true }));
app.use((err, req, res, next) => {
  console.error('Fehler in', req.method, req.path, err);
  if (res.headersSent) return next(err);
  // Angemeldete Benutzer sehen die Ursache (z. B. „bexio GET /2.0/contact: 503 …“),
  // nicht angemeldete nur eine allgemeine Meldung.
  const message = req.session?.user?.id && err?.message ? String(err.message).slice(0, 500) : 'Interner Fehler.';
  res.status(500).json({ error: message });
});

initDb().then(() => {
  app.listen(PORT, () => console.log(`bexio Lieferportal auf Port ${PORT} · dryRun=${DRY_RUN}`));
}).catch(err => { console.error(err); process.exit(1); });
