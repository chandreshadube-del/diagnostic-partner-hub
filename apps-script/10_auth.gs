/* ============================================================================
 *  AUTH (BRD §2.2) — app-managed logins, PBKDF2-HMAC-SHA256 salted hashes,
 *  Admin-issued temporary passwords, forced first change, lockout, sessions.
 * ==========================================================================*/

function hexToBytes_(hex) {
  const out = [];
  for (let i = 0; i < hex.length; i += 2) { let b = parseInt(hex.substr(i, 2), 16); if (b > 127) b -= 256; out.push(b); }
  return out;
}
function bytesToHex_(bytes) { return bytes.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join(''); }
function randomHex_(nBytes) {
  let s = '';
  while (s.length < nBytes * 2) s += Utilities.getUuid().replace(/-/g, '');
  return s.slice(0, nBytes * 2);
}

/** PBKDF2-HMAC-SHA256, single 32-byte block. Returns signed byte array. */
function pbkdf2_(password, saltBytes, iterations) {
  const key = Utilities.newBlob(String(password)).getBytes();
  let u = Utilities.computeHmacSha256Signature(saltBytes.concat([0, 0, 0, 1]), key);
  const t = u.slice();
  for (let i = 1; i < iterations; i++) {
    u = Utilities.computeHmacSha256Signature(u, key);
    for (let j = 0; j < t.length; j++) t[j] ^= u[j];
  }
  return t;
}
/** Stored format: p2$<iterations>$<saltHex>$<hashHex> (matches the seed workbook). */
function hashPassword_(pw) {
  const iter = cfgNum_('PBKDF2_ITERATIONS') || 2000;
  const saltHex = randomHex_(8);
  return 'p2$' + iter + '$' + saltHex + '$' + bytesToHex_(pbkdf2_(pw, hexToBytes_(saltHex), iter));
}
function verifyPassword_(pw, stored) {
  const parts = str_(stored).split('$');
  if (parts.length !== 4 || parts[0] !== 'p2') return false;
  const iter = Number(parts[1]);
  if (!(iter > 0 && iter <= 200000)) return false;
  const calc = bytesToHex_(pbkdf2_(pw, hexToBytes_(parts[2]), iter));
  const want = parts[3].toLowerCase();
  if (calc.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < calc.length; i++) diff |= calc.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

function genTempPassword_() {
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const all = alpha + digits;
  const hex = randomHex_(20);
  let pw = '';
  for (let i = 0; i < 10; i++) pw += all[parseInt(hex.substr(i * 2, 2), 16) % all.length];
  // guarantee at least one letter and one digit
  pw = alpha[parseInt(hex.substr(20, 2), 16) % alpha.length] + pw.slice(1, 9) + digits[parseInt(hex.substr(22, 2), 16) % digits.length];
  return pw;
}

function checkPasswordPolicy_(pw) {
  const min = cfgNum_('PASSWORD_MIN_LENGTH') || 8;
  need_(typeof pw === 'string' && pw.length >= min, 'Password must be at least ' + min + ' characters.');
  need_(pw.length <= 64, 'Password must be at most 64 characters.');
  need_(/^[A-Za-z0-9]+$/.test(pw), 'Password must be alphanumeric (letters and numbers only).');
  need_(/[A-Za-z]/.test(pw) && /[0-9]/.test(pw), 'Password must contain at least one letter and one number.');
}

/* ----------------------------------------------------------------------------
 *  Sessions — CacheService (max 6h per put; refreshed on every request) with
 *  an absolute expiry of SESSION_TTL_HOURS.
 * --------------------------------------------------------------------------*/
function putSession_(token, s) {
  const ttl = Math.max(60, Math.min(21600, Math.floor((s.exp - Date.now()) / 1000)));
  CacheService.getScriptCache().put('S_' + token, JSON.stringify(s), ttl);
}
function createSession_(user, limited) {
  const token = randomHex_(24);
  putSession_(token, { u: str_(user.UserID), exp: Date.now() + cfgNum_('SESSION_TTL_HOURS') * 3600000, lim: !!limited });
  return token;
}
function getSession_(token) {
  if (!token || !/^[0-9a-f]{48}$/.test(String(token))) return null;
  const raw = CacheService.getScriptCache().get('S_' + token);
  if (!raw) return null;
  const s = JSON.parse(raw);
  if (Date.now() > s.exp) { CacheService.getScriptCache().remove('S_' + token); return null; }
  putSession_(token, s);
  return s;
}
function removeSession_(token) { if (token) CacheService.getScriptCache().remove('S_' + token); }

function userByEmail_(email) {
  const e = str_(email).toLowerCase();
  return DB.rows(SH.USERS).find(r => str_(r.Email).toLowerCase() === e) || null;
}

/** Builds the request context for an authenticated session. */
function authCtx_(token, allowLimited) {
  const s = getSession_(token);
  if (!s) fail_('Your session has expired. Please sign in again.', 'SESSION_EXPIRED');
  const u = user_(s.u);
  if (!u || !bool_(u.Active)) { removeSession_(token); fail_('Your access has been deactivated. Contact the DCP Admin.', 'SESSION_EXPIRED'); }
  if (s.lim && !allowLimited) fail_('Please set a new password to continue.', 'PASSWORD_CHANGE_REQUIRED');
  const ctx = buildCtx_(u);
  need_(ROLE_LIST.indexOf(ctx.role) >= 0, 'Your account\'s Role is "' + str_(u.Role) + '", which the app doesn\'t recognise. ' +
    'Ask the DCP Admin to set Users.Role for ' + str_(u.Email) + ' to exactly one of: ' + ROLE_LIST.join(', ') + '.');
  ctx.token = token;
  ctx.limited = !!s.lim;
  return ctx;
}

/**
 * Canonical role name for a Users.Role cell, matched without regard to case
 * ('admin', 'ADMIN' → 'Admin'). An unrecognised value is returned unchanged so
 * the caller can name it in the error; the client builds its whole navigation
 * from this string, so a near-miss would otherwise render an app with no menu.
 */
const ROLE_LIST = Object.keys(ROLE).map(k => ROLE[k]);
function normRole_(v) {
  const s = str_(v).toLowerCase();
  return ROLE_LIST.find(r => r.toLowerCase() === s) || str_(v);
}

function buildCtx_(u) {
  const ctx = {
    user: u, userId: str_(u.UserID), email: str_(u.Email), name: str_(u.Name), role: normRole_(u.Role),
    orgType: str_(u.OrgType), orgId: str_(u.OrgID), scopeType: str_(u.ScopeType).toUpperCase(),
    scopeIds: splitList_(u.ScopeIDs), partnerId: '', labIds: [], clinicIds: []
  };
  if (ctx.role === ROLE.PC) ctx.partnerId = ctx.orgId;
  if (ctx.role === ROLE.LAB) {
    ctx.labIds = ctx.scopeType === 'LAB' && ctx.scopeIds.length ? ctx.scopeIds : [ctx.orgId];
    const lb = lab_(ctx.labIds[0]);
    ctx.partnerId = lb ? str_(lb.PartnerID) : '';
  }
  if (ctx.role === ROLE.CM) ctx.clinicIds = uniq_([ctx.orgId].concat(ctx.scopeType === 'CLINIC' ? ctx.scopeIds : []).filter(Boolean));
  ctx.clinicScope = clinicScopeSet_(ctx);
  return ctx;
}

/** Region → Area → Clinic scope cascade (BRD §2.4). Returns null for whole-network scope. */
function clinicScopeSet_(ctx) {
  if (ctx.role === ROLE.ADMIN || ctx.scopeType === 'ALL') return null;
  const set = {};
  if (ctx.role === ROLE.LAB) return set; // lab users are scoped by LabID, not clinics
  const clinics = DB.rows(SH.CLINICS);
  if (ctx.scopeType === 'REGION') clinics.forEach(c => { if (ctx.scopeIds.indexOf(str_(c.RegionID)) >= 0) set[str_(c.ClinicID)] = 1; });
  else if (ctx.scopeType === 'AREA') clinics.forEach(c => { if (ctx.scopeIds.indexOf(str_(c.AreaID)) >= 0) set[str_(c.ClinicID)] = 1; });
  else ctx.scopeIds.forEach(id => { set[id] = 1; });
  ctx.clinicIds.forEach(id => { set[id] = 1; });
  return set;
}

function inClinicScope_(ctx, clinicId) { return ctx.clinicScope === null || !!ctx.clinicScope[str_(clinicId)]; }

/** Server-side lead visibility (BRD §2.4 scope resolution rules). */
function canSeeLead_(ctx, lead) {
  switch (ctx.role) {
    case ROLE.ADMIN: return true;
    case ROLE.CM: return inClinicScope_(ctx, lead.ClinicID);
    case ROLE.PC: return str_(lead.PartnerID) === ctx.partnerId && inClinicScope_(ctx, lead.ClinicID);
    case ROLE.LAB: return !!str_(lead.AssignedLabID) && ctx.labIds.indexOf(str_(lead.AssignedLabID)) >= 0;
  }
  return false;
}
function assertSee_(ctx, lead) { need_(lead && canSeeLead_(ctx, lead), 'Lead not found or outside your access scope.'); }

/* ----------------------------------------------------------------------------
 *  Login / password flows
 * --------------------------------------------------------------------------*/
function login_(p) {
  const generic = 'Invalid email or password.';
  const email = str_(p.email).toLowerCase(), pw = String(p.password || '');
  need_(email && pw, 'Enter your email and password.');
  const u = userByEmail_(email);
  if (!u || !bool_(u.Active)) { Utilities.sleep(400); fail_(generic); }
  const now = new Date();
  const lockedUntil = parseDT_(u.LockedUntil);
  if (lockedUntil && lockedUntil > now) {
    fail_('Account locked after repeated failed attempts. Try again after ' + fmtDT_(lockedUntil) + ' IST, or use "Forgot password".');
  }
  const ctxLike = buildCtx_(u);
  if (!verifyPassword_(pw, u.PasswordHash)) {
    u.FailedAttempts = num_(u.FailedAttempts) + 1;
    let note = 'Failed attempt ' + u.FailedAttempts;
    if (u.FailedAttempts >= cfgNum_('LOCKOUT_ATTEMPTS')) {
      u.LockedUntil = fmtDT_(new Date(now.getTime() + cfgNum_('LOCKOUT_MINUTES') * 60000));
      u.FailedAttempts = 0;
      note = 'Locked until ' + u.LockedUntil;
    }
    DB.update(SH.USERS, u);
    audit_(ctxLike, 'LOGIN_FAILED', '', 'User', u.UserID, null, null, note);
    fail_(generic);
  }
  const force = bool_(u.ForcePasswordChange);
  if (force) {
    const exp = parseDT_(u.TempPasswordExpiry);
    if (exp && exp < now) fail_('Your temporary password has expired. Use "Forgot password" or ask the DCP Admin for a new one.');
  }
  if (num_(u.FailedAttempts) || str_(u.LockedUntil)) { u.FailedAttempts = 0; u.LockedUntil = ''; DB.update(SH.USERS, u); }
  const token = createSession_(u, force);
  audit_(ctxLike, 'LOGIN', '', 'User', u.UserID, null, null, force ? 'Temporary password — change required' : '');
  if (force) return { token: token, mustChangePassword: true, name: str_(u.Name) };
  const ctx = buildCtx_(u); ctx.token = token;
  return { token: token, mustChangePassword: false, boot: bootstrap_(ctx) };
}

function changePassword_(ctx, p) {
  const u = ctx.user;
  const newPw = String(p.newPassword || '');
  if (!ctx.limited) need_(verifyPassword_(String(p.currentPassword || ''), u.PasswordHash), 'Current password is incorrect.');
  checkPasswordPolicy_(newPw);
  need_(newPw === String(p.confirmPassword || ''), 'The two new passwords do not match.');
  need_(!verifyPassword_(newPw, u.PasswordHash), 'New password must be different from the current one.');
  u.PasswordHash = hashPassword_(newPw);
  u.ForcePasswordChange = false;
  u.TempPasswordExpiry = '';
  u.FailedAttempts = 0;
  u.LockedUntil = '';
  DB.update(SH.USERS, u);
  removeSession_(ctx.token);
  const token = createSession_(u, false);
  audit_(ctx, 'PASSWORD_CHANGED', '', 'User', u.UserID, null, null, '');
  const fresh = buildCtx_(u); fresh.token = token;
  return { token: token, boot: bootstrap_(fresh) };
}

/** Sets a new temporary password; returns it (shown once to the Admin for sharing). */
function issueTempPassword_(actorCtx, u, reason) {
  const temp = genTempPassword_();
  u.PasswordHash = hashPassword_(temp);
  u.ForcePasswordChange = true;
  u.TempPasswordExpiry = fmtDT_(new Date(Date.now() + cfgNum_('TEMP_PW_EXPIRY_HOURS') * 3600000));
  u.FailedAttempts = 0;
  u.LockedUntil = '';
  DB.update(SH.USERS, u);
  const url = appUrl_();
  const mailed = sendMail_(u.Email, 'Your Gynoveda DCP login',
    '<p>Hello ' + escHtml_(u.Name) + ',</p>' +
    '<p>Your Gynoveda DCP app login is ready.</p>' +
    '<p><b>App:</b> <a href="' + escHtml_(url) + '">' + escHtml_(url || '(link shared by your Admin)') + '</a><br>' +
    '<b>Login ID:</b> ' + escHtml_(u.Email) + '<br><b>Temporary password:</b> ' + escHtml_(temp) + '</p>' +
    '<p>You will be asked to set your own password at first sign-in. This temporary password expires on ' +
    escHtml_(u.TempPasswordExpiry) + ' IST.</p><p>— Gynoveda DCP</p>');
  audit_(actorCtx, 'TEMP_PASSWORD_ISSUED', '', 'User', u.UserID, null, null, reason + (mailed ? ' · emailed' : ' · email not sent'));
  return { tempPassword: temp, expires: u.TempPasswordExpiry, emailed: mailed, appUrl: url };
}

function forgotPassword_(p) {
  const email = str_(p.email).toLowerCase();
  const msg = 'If this email is registered, a new temporary password has been sent to it.';
  if (!email) return { message: msg };
  const cache = CacheService.getScriptCache();
  if (cache.get('FP_' + email)) return { message: msg };
  cache.put('FP_' + email, '1', 600);
  const u = userByEmail_(email);
  if (u && bool_(u.Active)) issueTempPassword_(buildCtx_(u), u, 'Forgot password');
  return { message: msg };
}

function logout_(ctx) { removeSession_(ctx.token); return { ok: true }; }
