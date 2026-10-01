const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');

const GATE_VERSION = 'relay-site-code-v4';
const secret = () => process.env.JWT_SECRET || 'dev-only-change-me';
const sitePasscodeValue = () => process.env.SITE_ACCESS_CODE || 'boisverysigma123';

function sign(payload, expiresIn = '7d') {
  return jwt.sign(payload, secret(), { expiresIn });
}

function verify(token) {
  return jwt.verify(token, secret());
}

function sitePasscode() {
  return sitePasscodeValue();
}

function gateFingerprint() {
  return crypto.createHash('sha256').update(`${GATE_VERSION}:${sitePasscodeValue()}`).digest('hex').slice(0, 24);
}

function requireGate(req, res, next) {
  try {
    const data = verify(req.cookies.site_access);
    if (!data || data.scope !== 'site' || data.gate !== gateFingerprint()) throw new Error('invalid gate');
    req.siteAccess = data;
    next();
  } catch {
    res.status(401).json({ error: 'LICENSE_REQUIRED' });
  }
}

function requireUser(req, res, next) {
  try {
    const data = verify(req.cookies.session);
    if (!data || data.scope !== 'user' || !data.userId) throw new Error('invalid session');
    req.user = data;
    next();
  } catch {
    res.status(401).json({ error: 'AUTH_REQUIRED' });
  }
}

module.exports = { sign, verify, requireGate, requireUser, gateFingerprint, sitePasscode };
