require('dotenv').config?.();
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const supabase = require('./db');
const { sign, verify, requireGate, requireUser, gateFingerprint, sitePasscode } = require('./auth');
const { cleanUsername, publicUser, getLinkPreview } = require('./utils');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });
const PORT = Number(process.env.PORT || 3000);
const production = process.env.NODE_ENV === 'production';
const OWNER_USERNAME = cleanUsername(process.env.OWNER_USERNAME || 'alex');
const MESSAGE_HISTORY_LIMIT = 100;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MEDIA_BUCKET = 'chat-media';
const online = new Map();

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      scriptSrc: ["'self'"]
    }
  }
}));
app.use(express.json({ limit: '8mb' }));
app.use(cookieParser());
app.get('/styles.css', (_, res) => res.sendFile(path.join(__dirname, 'styles.css')));
app.get('/app.js', (_, res) => res.sendFile(path.join(__dirname, 'app.js')));
app.get('/network.js', (_, res) => res.sendFile(path.join(__dirname, 'network.js')));

const gateLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 25, standardHeaders: 'draft-8', legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 45, standardHeaders: 'draft-8', legacyHeaders: false });
const uploadLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
const pingLimiter = new Map();

function cookieOptions(days = 7) {
  return { httpOnly: true, sameSite: 'lax', secure: production, maxAge: days * 86400000, path: '/' };
}
function emitToUser(userId, event, payload) { io.to(`user:${userId}`).emit(event, payload); }
function emitToUsers(ids, event, payload) { [...new Set(ids)].forEach(id => emitToUser(id, event, payload)); }
function licenseHash(raw) { return crypto.createHash('sha256').update(String(raw).trim().toUpperCase()).digest('hex'); }
function generateLicenseKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () => Array.from({ length: 4 }, () => alphabet[crypto.randomInt(0, alphabet.length)]).join('');
  return `RLY-${part()}-${part()}-${part()}-${part()}`;
}
function parseDataUrl(dataUrl = '') {
  const m = String(dataUrl).match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/i);
  if (!m) return null;
  const buffer = Buffer.from(m[2], 'base64');
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) return null;
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[m[1].toLowerCase()];
  return { buffer, mime: m[1].toLowerCase(), ext };
}
function normalizeAttachment(input, userId) {
  if (!input || input.type !== 'image' || !input.url || !input.path) return null;
  const expectedPrefix = `${String(process.env.SUPABASE_URL || '').replace(/\/$/, '')}/storage/v1/object/public/${MEDIA_BUCKET}/`;
  if (!expectedPrefix.startsWith('https://') || !String(input.url).startsWith(expectedPrefix)) return null;
  if (!String(input.path).startsWith(`${userId}/`)) return null;
  return {
    url: String(input.url).slice(0, 1400),
    path: String(input.path).slice(0, 500),
    type: 'image',
    name: String(input.name || 'image').slice(0, 100)
  };
}
async function deleteMediaPaths(paths) {
  const clean = [...new Set((paths || []).filter(Boolean))];
  if (clean.length) await supabase.storage.from(MEDIA_BUCKET).remove(clean);
}
async function currentUser(userId) {
  const { data } = await supabase.from('users').select('*').eq('id', userId).maybeSingle();
  if (!data) return null;
  if (data.username === OWNER_USERNAME && data.role !== 'admin') {
    const { data: promoted } = await supabase.from('users').update({ role: 'admin', is_banned: false, ban_reason: '' }).eq('id', data.id).select('*').single();
    return promoted || data;
  }
  return data;
}
async function requireActive(req, res, next) {
  const user = await currentUser(req.user.userId);
  if (!user) return res.status(401).json({ error: 'AUTH_REQUIRED' });
  if (user.is_banned) return res.status(403).json({ error: 'ACCOUNT_BANNED', reason: user.ban_reason || '' });
  req.currentUser = user;
  next();
}
function requireStaff(req, res, next) {
  if (!['admin', 'mod'].includes(req.currentUser?.role)) return res.status(403).json({ error: 'STAFF_ONLY' });
  next();
}
function requireAdmin(req, res, next) {
  if (req.currentUser?.role !== 'admin') return res.status(403).json({ error: 'ADMIN_ONLY' });
  next();
}
async function audit(actorId, action, targetUserId = null, details = {}) {
  await supabase.from('moderation_logs').insert({ actor_id: actorId, action, target_user_id: targetUserId, details }).then(() => {});
}
async function areFriends(a, b) {
  const { data } = await supabase.from('friendships').select('status,sender_id,receiver_id')
    .or(`and(sender_id.eq.${a},receiver_id.eq.${b}),and(sender_id.eq.${b},receiver_id.eq.${a})`).maybeSingle();
  return data?.status === 'accepted';
}
async function groupForUser(groupId, userId) {
  const { data } = await supabase.from('group_members').select('group_id,user_id,role').eq('group_id', groupId).eq('user_id', userId).maybeSingle();
  return data;
}
async function groupMembers(groupId) {
  const { data } = await supabase.from('group_members').select('user_id').eq('group_id', groupId);
  return (data || []).map(x => x.user_id);
}
async function pruneDm(a, b) {
  const pair = `and(sender_id.eq.${a},receiver_id.eq.${b}),and(sender_id.eq.${b},receiver_id.eq.${a})`;
  const { data: old } = await supabase.from('messages').select('id,attachment_path').or(pair).order('created_at', { ascending: false }).range(MESSAGE_HISTORY_LIMIT, MESSAGE_HISTORY_LIMIT + 999);
  if (!old?.length) return;
  await deleteMediaPaths(old.map(x => x.attachment_path));
  await supabase.from('messages').delete().in('id', old.map(x => x.id));
}
async function pruneGroup(groupId) {
  const { data: old } = await supabase.from('group_messages').select('id,attachment_path').eq('group_id', groupId).order('created_at', { ascending: false }).range(MESSAGE_HISTORY_LIMIT, MESSAGE_HISTORY_LIMIT + 999);
  if (!old?.length) return;
  await deleteMediaPaths(old.map(x => x.attachment_path));
  await supabase.from('group_messages').delete().in('id', old.map(x => x.id));
}

app.get('/health', (_, res) => res.json({ ok: true }));
app.get('/api/bootstrap', async (req, res) => {
  let gate = false, user = null;
  try { const g = verify(req.cookies.site_access); gate = g.scope === 'site' && g.gate === gateFingerprint(); } catch {}
  try {
    const s = verify(req.cookies.session);
    if (s.scope === 'user') user = publicUser(await currentUser(s.userId));
  } catch {}
  res.json({ gate, user });
});

app.post('/api/gate', gateLimiter, async (req, res) => {
  const provided = String(req.body?.passcode || '').trim();
  if (!provided) return res.status(401).json({ error: 'INVALID_LICENSE' });
  let licenseId = null;
  let expiresIn = '30d';
  if (provided !== sitePasscode()) {
    const { data: key } = await supabase.from('license_keys').select('*').eq('key_hash', licenseHash(provided)).maybeSingle();
    const now = Date.now();
    if (!key || !key.is_active || (key.expires_at && new Date(key.expires_at).getTime() <= now) || key.uses >= key.max_uses) {
      return res.status(401).json({ error: 'INVALID_LICENSE' });
    }
    licenseId = key.id;
    const { error } = await supabase.from('license_keys').update({ uses: key.uses + 1, last_used_at: new Date().toISOString() }).eq('id', key.id).eq('uses', key.uses);
    if (error) return res.status(409).json({ error: 'LICENSE_RETRY' });
    if (key.expires_at) {
      const days = Math.max(1, Math.ceil((new Date(key.expires_at).getTime() - now) / 86400000));
      expiresIn = `${Math.min(days, 30)}d`;
    }
  }
  res.cookie('site_access', sign({ scope: 'site', gate: gateFingerprint(), licenseId, master: !licenseId }, expiresIn), cookieOptions(30));
  res.json({ ok: true });
});

app.post('/api/auth/register', authLimiter, requireGate, async (req, res) => {
  const username = cleanUsername(req.body?.username);
  const displayName = String(req.body?.displayName || '').trim();
  const password = String(req.body?.password || '');
  if (!/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'USERNAME_RULES' });
  if (displayName.length < 1 || displayName.length > 40) return res.status(400).json({ error: 'DISPLAY_NAME_RULES' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'PASSWORD_RULES' });
  const { data: existing } = await supabase.from('users').select('id').eq('username', username).maybeSingle();
  if (existing) return res.status(409).json({ error: 'USERNAME_TAKEN' });
  const password_hash = await bcrypt.hash(password, 12);
  const role = username === OWNER_USERNAME ? 'admin' : 'user';
  const { data, error } = await supabase.from('users').insert({ username, display_name: displayName, password_hash, role }).select('*').single();
  if (error) return res.status(500).json({ error: 'REGISTER_FAILED' });
  res.cookie('session', sign({ scope: 'user', userId: data.id, username: data.username }, '14d'), cookieOptions(14));
  res.json({ user: publicUser(data) });
});

app.post('/api/auth/login', authLimiter, requireGate, async (req, res) => {
  const username = cleanUsername(req.body?.username);
  const password = String(req.body?.password || '');
  let { data } = await supabase.from('users').select('*').eq('username', username).maybeSingle();
  if (!data || !(await bcrypt.compare(password, data.password_hash))) return res.status(401).json({ error: 'INVALID_LOGIN' });
  data = await currentUser(data.id);
  if (data.is_banned) return res.status(403).json({ error: 'ACCOUNT_BANNED', reason: data.ban_reason || '' });
  await supabase.from('users').update({ last_seen: new Date().toISOString() }).eq('id', data.id);
  res.cookie('session', sign({ scope: 'user', userId: data.id, username: data.username }, '14d'), cookieOptions(14));
  res.json({ user: publicUser(data) });
});
app.post('/api/auth/logout', (_, res) => { res.clearCookie('session', { path: '/' }); res.json({ ok: true }); });

app.use('/api', (req, res, next) => {
  if (['/bootstrap','/gate','/auth/register','/auth/login','/auth/logout'].includes(req.path)) return next();
  return requireGate(req, res, () => requireUser(req, res, () => requireActive(req, res, next)));
});

app.get('/api/me', async (req, res) => res.json({ user: publicUser(req.currentUser) }));
app.patch('/api/me', async (req, res) => {
  const patch = {};
  if (typeof req.body.displayName === 'string') patch.display_name = req.body.displayName.trim().slice(0, 40);
  if (typeof req.body.customStatus === 'string') patch.custom_status = req.body.customStatus.trim().slice(0, 80);
  if (['online','idle','dnd','offline'].includes(req.body.status)) patch.status = req.body.status;
  if (typeof req.body.avatarUrl === 'string') {
    const avatar = req.body.avatarUrl.trim().slice(0, 800);
    if (avatar && !/^https:\/\//i.test(avatar)) return res.status(400).json({ error: 'AVATAR_URL_RULES' });
    patch.avatar_url = avatar || null;
  }
  const { data, error } = await supabase.from('users').update(patch).eq('id', req.currentUser.id).select('*').single();
  if (error) return res.status(400).json({ error: 'UPDATE_FAILED' });
  io.emit('presence:update', { userId: data.id, status: data.status, lastSeen: data.last_seen, user: publicUser(data) });
  res.json({ user: publicUser(data) });
});

app.get('/api/users/search', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 40);
  if (q.length < 2) return res.json({ users: [] });
  const { data } = await supabase.from('users').select('id,username,display_name,avatar_url,custom_status,status,last_seen')
    .or(`username.ilike.%${q.replace(/[%_,]/g,'')}%,display_name.ilike.%${q.replace(/[%_,]/g,'')}%`).neq('id', req.currentUser.id).eq('is_banned', false).limit(12);
  res.json({ users: data || [] });
});

app.get('/api/friends', async (req, res) => {
  const uid = req.currentUser.id;
  const { data: rels } = await supabase.from('friendships').select('*').or(`sender_id.eq.${uid},receiver_id.eq.${uid}`).order('updated_at', { ascending: false });
  const ids = [...new Set((rels || []).flatMap(r => [r.sender_id, r.receiver_id]).filter(id => id !== uid))];
  let users = [];
  if (ids.length) {
    const { data } = await supabase.from('users').select('id,username,display_name,avatar_url,custom_status,status,last_seen').in('id', ids);
    users = data || [];
  }
  const map = Object.fromEntries(users.map(u => [u.id, u]));
  res.json({ relationships: (rels || []).map(r => ({ ...r, user: map[r.sender_id === uid ? r.receiver_id : r.sender_id] })).filter(r => r.user) });
});
app.post('/api/friends/request/:userId', async (req, res) => {
  const uid = req.currentUser.id, other = req.params.userId;
  if (uid === other) return res.status(400).json({ error: 'SELF' });
  const { data: exists } = await supabase.from('friendships').select('id').or(`and(sender_id.eq.${uid},receiver_id.eq.${other}),and(sender_id.eq.${other},receiver_id.eq.${uid})`).maybeSingle();
  if (exists) return res.status(409).json({ error: 'RELATION_EXISTS' });
  const { data, error } = await supabase.from('friendships').insert({ sender_id: uid, receiver_id: other }).select('*').single();
  if (error) return res.status(400).json({ error: 'REQUEST_FAILED' });
  emitToUser(other, 'friends:update', {});
  res.json({ relationship: data });
});
app.post('/api/friends/:id/accept', async (req, res) => {
  const { data, error } = await supabase.from('friendships').update({ status: 'accepted', updated_at: new Date().toISOString() }).eq('id', req.params.id).eq('receiver_id', req.currentUser.id).eq('status', 'pending').select('*').maybeSingle();
  if (error || !data) return res.status(404).json({ error: 'REQUEST_NOT_FOUND' });
  emitToUser(data.sender_id, 'friends:update', {});
  res.json({ relationship: data });
});
app.delete('/api/friends/:id', async (req, res) => {
  const { data } = await supabase.from('friendships').select('*').eq('id', req.params.id).maybeSingle();
  if (!data || ![data.sender_id,data.receiver_id].includes(req.currentUser.id)) return res.status(404).json({ error: 'NOT_FOUND' });
  await supabase.from('friendships').delete().eq('id', data.id);
  emitToUsers([data.sender_id,data.receiver_id], 'friends:update', {});
  res.json({ ok: true });
});

app.get('/api/conversations', async (req, res) => {
  const uid = req.currentUser.id;
  const { data: rels } = await supabase.from('friendships').select('*').eq('status', 'accepted').or(`sender_id.eq.${uid},receiver_id.eq.${uid}`);
  const friendIds = (rels || []).map(r => r.sender_id === uid ? r.receiver_id : r.sender_id);
  let users = [];
  if (friendIds.length) {
    const { data } = await supabase.from('users').select('id,username,display_name,avatar_url,custom_status,status,last_seen').in('id', friendIds);
    users = data || [];
  }
  const conversations = [];
  for (const u of users) {
    const pair = `and(sender_id.eq.${uid},receiver_id.eq.${u.id}),and(sender_id.eq.${u.id},receiver_id.eq.${uid})`;
    const { data: last } = await supabase.from('messages').select('id,sender_id,receiver_id,content,attachment_type,created_at').or(pair).order('created_at', { ascending: false }).limit(1).maybeSingle();
    conversations.push({ type: 'dm', id: u.id, user: u, last });
  }
  const { data: memberships } = await supabase.from('group_members').select('group_id').eq('user_id', uid);
  const groupIds = (memberships || []).map(x => x.group_id);
  if (groupIds.length) {
    const { data: groups } = await supabase.from('group_chats').select('*').in('id', groupIds);
    for (const g of groups || []) {
      const { data: last } = await supabase.from('group_messages').select('id,sender_id,content,attachment_type,created_at').eq('group_id', g.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
      const { data: members } = await supabase.from('group_members').select('user_id').eq('group_id', g.id);
      conversations.push({ type: 'group', id: g.id, group: g, member_count: members?.length || 0, last });
    }
  }
  conversations.sort((a,b) => new Date(b.last?.created_at || b.group?.created_at || 0) - new Date(a.last?.created_at || 0));
  res.json({ conversations });
});

app.get('/api/messages/:userId', async (req, res) => {
  const uid = req.currentUser.id, other = req.params.userId;
  if (!(await areFriends(uid, other)) && !['admin','mod'].includes(req.currentUser.role)) return res.status(403).json({ error: 'FRIENDS_ONLY' });
  const pair = `and(sender_id.eq.${uid},receiver_id.eq.${other}),and(sender_id.eq.${other},receiver_id.eq.${uid})`;
  const { data: messages } = await supabase.from('messages').select('*').or(pair).order('created_at', { ascending: false }).limit(MESSAGE_HISTORY_LIMIT);
  const ids = [...new Set((messages || []).flatMap(m => [m.sender_id,m.receiver_id]))];
  let users = [];
  if (ids.length) { const { data } = await supabase.from('users').select('id,username,display_name,avatar_url').in('id',ids); users = data || []; }
  res.json({ messages: (messages || []).reverse(), users });
});
app.post('/api/messages/:userId', async (req, res) => {
  const uid = req.currentUser.id, other = req.params.userId;
  if (!(await areFriends(uid, other))) return res.status(403).json({ error: 'FRIENDS_ONLY' });
  const content = String(req.body?.content || '').trim().slice(0, 4000);
  const attachment = normalizeAttachment(req.body?.attachment, uid);
  if (!content && !attachment?.url) return res.status(400).json({ error: 'EMPTY_MESSAGE' });
  const row = { sender_id: uid, receiver_id: other, content, attachment_url: attachment?.url || null, attachment_path: attachment?.path || null, attachment_type: attachment?.type || null, attachment_name: attachment?.name || null };
  const { data, error } = await supabase.from('messages').insert(row).select('*').single();
  if (error) return res.status(400).json({ error: 'MESSAGE_FAILED' });
  emitToUsers([uid,other], 'message:new', data);
  pruneDm(uid, other).catch(()=>{});
  res.json({ message: data });
});
app.delete('/api/messages/:id', async (req, res) => {
  const { data: m } = await supabase.from('messages').select('*').eq('id', req.params.id).maybeSingle();
  if (!m || (m.sender_id !== req.currentUser.id && !['admin','mod'].includes(req.currentUser.role))) return res.status(404).json({ error: 'NOT_FOUND' });
  if (m.attachment_path) await deleteMediaPaths([m.attachment_path]);
  await supabase.from('messages').delete().eq('id', m.id);
  emitToUsers([m.sender_id,m.receiver_id], 'message:delete', { id: m.id });
  res.json({ ok: true });
});
app.post('/api/messages/:id/read', async (req, res) => {
  const { data: m } = await supabase.from('messages').select('*').eq('id', req.params.id).maybeSingle();
  if (!m || m.receiver_id !== req.currentUser.id) return res.json({ ok: true });
  await supabase.from('message_reads').upsert({ message_id: m.id, reader_id: req.currentUser.id, read_at: new Date().toISOString() });
  emitToUser(m.sender_id, 'message:read', { messageId: m.id, readerId: req.currentUser.id, readAt: new Date().toISOString() });
  res.json({ ok: true });
});

app.post('/api/uploads/image', uploadLimiter, async (req, res) => {
  const parsed = parseDataUrl(req.body?.dataUrl);
  if (!parsed) return res.status(400).json({ error: 'IMAGE_RULES' });
  const safeName = String(req.body?.name || `image.${parsed.ext}`).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const objectPath = `${req.currentUser.id}/${Date.now()}-${crypto.randomBytes(5).toString('hex')}.${parsed.ext}`;
  const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(objectPath, parsed.buffer, { contentType: parsed.mime, cacheControl: '31536000', upsert: false });
  if (error) return res.status(500).json({ error: 'UPLOAD_FAILED' });
  const { data } = supabase.storage.from(MEDIA_BUCKET).getPublicUrl(objectPath);
  res.json({ attachment: { url: data.publicUrl, path: objectPath, type: 'image', name: safeName } });
});
app.delete('/api/uploads/image', async (req, res) => {
  const objectPath = String(req.body?.path || '');
  if (!objectPath.startsWith(`${req.currentUser.id}/`)) return res.status(403).json({ error: 'NO_PERMISSION' });
  await deleteMediaPaths([objectPath]);
  res.json({ ok: true });
});

app.post('/api/groups', async (req, res) => {
  const friendIds = [...new Set((Array.isArray(req.body?.memberIds) ? req.body.memberIds : []).filter(Boolean))].slice(0, 19);
  if (!friendIds.length) return res.status(400).json({ error: 'MEMBERS_REQUIRED' });
  for (const id of friendIds) if (!(await areFriends(req.currentUser.id, id))) return res.status(403).json({ error: 'FRIENDS_ONLY' });
  const name = String(req.body?.name || '').trim().slice(0, 40) || 'GROUP CHAT';
  const { data: group, error } = await supabase.from('group_chats').insert({ name, created_by: req.currentUser.id }).select('*').single();
  if (error) return res.status(500).json({ error: 'GROUP_FAILED' });
  const members = [{ group_id: group.id, user_id: req.currentUser.id, role: 'owner' }, ...friendIds.map(user_id => ({ group_id: group.id, user_id, role: 'member' }))];
  await supabase.from('group_members').insert(members);
  emitToUsers(members.map(x=>x.user_id), 'groups:update', { groupId: group.id });
  res.json({ group });
});
app.get('/api/groups/:groupId', async (req, res) => {
  if (!(await groupForUser(req.params.groupId, req.currentUser.id))) return res.status(403).json({ error: 'GROUP_ONLY' });
  const { data: group } = await supabase.from('group_chats').select('*').eq('id', req.params.groupId).single();
  const { data: memberRows } = await supabase.from('group_members').select('user_id,role').eq('group_id', group.id);
  const ids = (memberRows || []).map(x=>x.user_id);
  let users=[];
  if(ids.length){const {data}=await supabase.from('users').select('id,username,display_name,avatar_url,status,last_seen').in('id',ids);users=data||[]}
  const roleMap=Object.fromEntries((memberRows||[]).map(x=>[x.user_id,x.role]));
  res.json({ group, members: users.map(u=>({...u,group_role:roleMap[u.id]})) });
});
app.get('/api/groups/:groupId/messages', async (req, res) => {
  if (!(await groupForUser(req.params.groupId, req.currentUser.id))) return res.status(403).json({ error: 'GROUP_ONLY' });
  const { data: messages } = await supabase.from('group_messages').select('*').eq('group_id', req.params.groupId).order('created_at', { ascending: false }).limit(MESSAGE_HISTORY_LIMIT);
  const ids = [...new Set((messages || []).map(m=>m.sender_id))];
  let users=[];
  if(ids.length){const {data}=await supabase.from('users').select('id,username,display_name,avatar_url').in('id',ids);users=data||[]}
  res.json({ messages: (messages || []).reverse(), users });
});
app.post('/api/groups/:groupId/messages', async (req, res) => {
  const groupId = req.params.groupId;
  if (!(await groupForUser(groupId, req.currentUser.id))) return res.status(403).json({ error: 'GROUP_ONLY' });
  const content = String(req.body?.content || '').trim().slice(0,4000);
  const attachment = normalizeAttachment(req.body?.attachment, req.currentUser.id);
  if (!content && !attachment?.url) return res.status(400).json({ error: 'EMPTY_MESSAGE' });
  const { data, error } = await supabase.from('group_messages').insert({ group_id: groupId, sender_id: req.currentUser.id, content, attachment_url: attachment?.url || null, attachment_path: attachment?.path || null, attachment_type: attachment?.type || null, attachment_name: attachment?.name || null }).select('*').single();
  if(error) return res.status(400).json({error:'MESSAGE_FAILED'});
  const members=await groupMembers(groupId);
  emitToUsers(members,'group:message:new',data);
  pruneGroup(groupId).catch(()=>{});
  res.json({message:data});
});
app.delete('/api/groups/:groupId/messages/:messageId', async (req,res)=>{
  const member=await groupForUser(req.params.groupId,req.currentUser.id);
  if(!member)return res.status(403).json({error:'GROUP_ONLY'});
  const {data:m}=await supabase.from('group_messages').select('*').eq('id',req.params.messageId).eq('group_id',req.params.groupId).maybeSingle();
  if(!m || (m.sender_id!==req.currentUser.id && !['owner','mod'].includes(member.role) && !['admin','mod'].includes(req.currentUser.role))) return res.status(403).json({error:'NO_PERMISSION'});
  if(m.attachment_path)await deleteMediaPaths([m.attachment_path]);
  await supabase.from('group_messages').delete().eq('id',m.id);
  emitToUsers(await groupMembers(req.params.groupId),'group:message:delete',{groupId:req.params.groupId,id:m.id});
  res.json({ok:true});
});

app.post('/api/ping/:userId', async (req,res)=>{
  const uid=req.currentUser.id,other=req.params.userId;
  if(!(await areFriends(uid,other)))return res.status(403).json({error:'FRIENDS_ONLY'});
  const key=`${uid}:${other}`,now=Date.now(),last=pingLimiter.get(key)||0;
  if(now-last<10000)return res.status(429).json({error:'PING_COOLDOWN',retryAfter:Math.ceil((10000-(now-last))/1000)});
  pingLimiter.set(key,now);emitToUser(other,'ping',{from:uid});res.json({ok:true});
});
app.get('/api/link-preview', async (req,res)=>{try{res.json(await getLinkPreview(String(req.query.url||'')))}catch{res.status(400).json({error:'PREVIEW_FAILED'})}});

// Admin / moderator tools
app.get('/api/admin/users', requireStaff, async (req,res)=>{
  const q=String(req.query.q||'').trim().slice(0,50).replace(/[%_,]/g,'');
  let query=supabase.from('users').select('id,username,display_name,avatar_url,role,is_banned,ban_reason,status,last_seen,created_at').order('created_at',{ascending:false}).limit(40);
  if(q)query=query.or(`username.ilike.%${q}%,display_name.ilike.%${q}%`);
  const {data}=await query;res.json({users:data||[]});
});
app.patch('/api/admin/users/:userId', requireStaff, async (req,res)=>{
  const targetId=req.params.userId;
  const {data:target}=await supabase.from('users').select('*').eq('id',targetId).maybeSingle();
  if(!target)return res.status(404).json({error:'NOT_FOUND'});
  if(target.username===OWNER_USERNAME)return res.status(403).json({error:'OWNER_PROTECTED'});
  if(target.role==='admin' && req.currentUser.role!=='admin')return res.status(403).json({error:'ADMIN_PROTECTED'});
  const patch={};
  if(typeof req.body.isBanned==='boolean'){patch.is_banned=req.body.isBanned;patch.ban_reason=req.body.isBanned?String(req.body.reason||'').trim().slice(0,160):''}
  if(typeof req.body.role==='string'){
    if(req.currentUser.role!=='admin')return res.status(403).json({error:'ADMIN_ONLY'});
    if(!['user','mod'].includes(req.body.role))return res.status(400).json({error:'ROLE_RULES'});
    patch.role=req.body.role;
  }
  const {data,error}=await supabase.from('users').update(patch).eq('id',targetId).select('id,username,display_name,avatar_url,role,is_banned,ban_reason,status,last_seen,created_at').single();
  if(error)return res.status(400).json({error:'UPDATE_FAILED'});
  await audit(req.currentUser.id,'user_update',targetId,patch);
  emitToUser(targetId,'account:update',{role:data.role,is_banned:data.is_banned});
  res.json({user:data});
});
app.get('/api/admin/users/:userId/conversations', requireStaff, async (req,res)=>{
  const uid=req.params.userId;
  const {data:msgs}=await supabase.from('messages').select('sender_id,receiver_id,created_at').or(`sender_id.eq.${uid},receiver_id.eq.${uid}`).order('created_at',{ascending:false}).limit(500);
  const partnerIds=[...new Set((msgs||[]).map(m=>m.sender_id===uid?m.receiver_id:m.sender_id))];
  let users=[];if(partnerIds.length){const {data}=await supabase.from('users').select('id,username,display_name,avatar_url').in('id',partnerIds);users=data||[]}
  const lastMap={};for(const m of msgs||[]){const p=m.sender_id===uid?m.receiver_id:m.sender_id;if(!lastMap[p])lastMap[p]=m.created_at}
  const dms=users.map(u=>({...u,last_at:lastMap[u.id]})).sort((a,b)=>new Date(b.last_at)-new Date(a.last_at));
  const {data:memberships}=await supabase.from('group_members').select('group_id').eq('user_id',uid);
  let groups=[];const gids=(memberships||[]).map(x=>x.group_id);if(gids.length){const {data}=await supabase.from('group_chats').select('id,name,created_at').in('id',gids);groups=data||[]}
  await audit(req.currentUser.id,'view_user_conversations',uid,{});
  res.json({dms,groups});
});
app.get('/api/admin/dm/:a/:b', requireStaff, async (req,res)=>{
  const {a,b}=req.params;const pair=`and(sender_id.eq.${a},receiver_id.eq.${b}),and(sender_id.eq.${b},receiver_id.eq.${a})`;
  const {data:messages}=await supabase.from('messages').select('*').or(pair).order('created_at',{ascending:false}).limit(MESSAGE_HISTORY_LIMIT);
  const {data:users}=await supabase.from('users').select('id,username,display_name,avatar_url').in('id',[a,b]);
  await audit(req.currentUser.id,'view_dm',a,{other_user_id:b});
  res.json({messages:(messages||[]).reverse(),users:users||[]});
});
app.get('/api/admin/group/:groupId', requireStaff, async (req,res)=>{
  const {data:messages}=await supabase.from('group_messages').select('*').eq('group_id',req.params.groupId).order('created_at',{ascending:false}).limit(MESSAGE_HISTORY_LIMIT);
  const ids=[...new Set((messages||[]).map(x=>x.sender_id))];let users=[];if(ids.length){const {data}=await supabase.from('users').select('id,username,display_name,avatar_url').in('id',ids);users=data||[]}
  await audit(req.currentUser.id,'view_group',null,{group_id:req.params.groupId});
  res.json({messages:(messages||[]).reverse(),users});
});
app.get('/api/admin/licenses', requireAdmin, async (req,res)=>{
  const {data}=await supabase.from('license_keys').select('id,key_prefix,label,max_uses,uses,expires_at,is_active,created_at,last_used_at').order('created_at',{ascending:false}).limit(100);
  res.json({keys:data||[]});
});
app.post('/api/admin/licenses', requireAdmin, async (req,res)=>{
  const raw=generateLicenseKey();
  const label=String(req.body?.label||'').trim().slice(0,50);
  const maxUses=Math.max(1,Math.min(50,Number(req.body?.maxUses)||3));
  const days=Math.max(1,Math.min(365,Number(req.body?.days)||30));
  const expiresAt=new Date(Date.now()+days*86400000).toISOString();
  const {data,error}=await supabase.from('license_keys').insert({key_hash:licenseHash(raw),key_prefix:raw.slice(0,8),label,max_uses:maxUses,expires_at:expiresAt,created_by:req.currentUser.id}).select('id,key_prefix,label,max_uses,uses,expires_at,is_active,created_at').single();
  if(error)return res.status(500).json({error:'KEY_FAILED'});
  await audit(req.currentUser.id,'license_generate',null,{license_id:data.id,label,maxUses,days});
  res.json({key:raw,record:data});
});
app.patch('/api/admin/licenses/:id', requireAdmin, async (req,res)=>{
  const isActive=!!req.body?.isActive;
  const {data,error}=await supabase.from('license_keys').update({is_active:isActive}).eq('id',req.params.id).select('id,key_prefix,label,max_uses,uses,expires_at,is_active,created_at,last_used_at').single();
  if(error)return res.status(404).json({error:'NOT_FOUND'});
  await audit(req.currentUser.id,isActive?'license_enable':'license_revoke',null,{license_id:req.params.id});
  res.json({key:data});
});

io.use((socket,next)=>{
  try{const raw=socket.handshake.headers.cookie||'';const token=raw.split(';').map(x=>x.trim()).find(x=>x.startsWith('session='))?.slice(8);const data=verify(decodeURIComponent(token||''));if(data.scope!=='user')throw new Error();socket.userId=data.userId;next()}catch{next(new Error('unauthorized'))}
});
io.on('connection',async socket=>{
  const uid=socket.userId;socket.join(`user:${uid}`);
  const count=(online.get(uid)||0)+1;online.set(uid,count);
  await supabase.from('users').update({status:'online',last_seen:new Date().toISOString()}).eq('id',uid);
  io.emit('presence:update',{userId:uid,status:'online',lastSeen:new Date().toISOString()});
  socket.on('typing:start',async ({to,type='dm'})=>{
    if(type==='dm' && await areFriends(uid,to))emitToUser(to,'typing:start',{from:uid,type});
    if(type==='group' && await groupForUser(to,uid))emitToUsers((await groupMembers(to)).filter(id=>id!==uid),'typing:start',{from:uid,type,groupId:to});
  });
  socket.on('typing:stop',async ({to,type='dm'})=>{
    if(type==='dm' && await areFriends(uid,to))emitToUser(to,'typing:stop',{from:uid,type});
    if(type==='group' && await groupForUser(to,uid))emitToUsers((await groupMembers(to)).filter(id=>id!==uid),'typing:stop',{from:uid,type,groupId:to});
  });
  socket.on('disconnect',async()=>{
    const nextCount=Math.max(0,(online.get(uid)||1)-1);if(nextCount)online.set(uid,nextCount);else online.delete(uid);
    if(!nextCount){const now=new Date().toISOString();await supabase.from('users').update({status:'offline',last_seen:now}).eq('id',uid);io.emit('presence:update',{userId:uid,status:'offline',lastSeen:now})}
  });
});

app.get('/{*splat}', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
server.listen(PORT, '0.0.0.0', () => console.log(`RELAY listening on :${PORT}`));
