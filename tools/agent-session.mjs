#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const names = ['Cedar', 'Maple', 'Willow', 'Birch', 'Aspen', 'Rowan', 'Hazel', 'Olive'];
const commands = ['boot', 'current', 'list', 'resolve', 'claim', 'release', 'end', 'send', 'broadcast', 'owner', 'check-owner', 'associate-pr', 'archive-message'];
const usage = 'agent-session <' + commands.join('|') + '> [--state-dir PATH] [--session-id ID --harness NAME] [--generation ID]\nSee orchestrate/session-bus.md for command flags and JSON results.';
const fail = (code, error, detail = {}) => { throw Object.assign(new Error(error), { code, detail }); };
const safe = (s) => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(s) && !s.includes('..');
const args = process.argv.slice(2);
const cmd = args.shift();
const opt = {};
let locked = false;
let lock;
try {
  if (cmd === '--help' || cmd === 'help') { console.log(usage); process.exit(0); }
  if (!commands.includes(cmd)) fail(2, usage);
  const allowed = new Set(['state-dir', 'session-id', 'harness', 'generation', 'role', 'lane', 'name', 'ticket', 'resource', 'confirmation', 'pr', 'quiescence', 'branch', 'to', 'triage', 'subject', 'body-file', 'message', 'owner-session-id', 'owner-harness', 'owner-generation']);
  while (args.length) {
    const key = args.shift(); const value = args.shift();
    if (!key?.startsWith('--') || !allowed.has(key.slice(2)) || !value || value.startsWith('--')) fail(2, 'Invalid option', { option: key });
    const k = key.slice(2);
    if (k === 'resource') (opt[k] ??= []).push(value);
    else { if (k in opt) fail(2, 'Duplicate option', { option: key }); opt[k] = value; }
  }
  const need = (key) => { if (!opt[key]?.trim()) fail(2, 'Required option missing', { option: '--' + key }); return opt[key]; };
  const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let stateDir = opt['state-dir'] || process.env.AGENT_STATE_DIR;
  if (!stateDir) {
    try {
      const common = path.resolve(git('rev-parse', '--git-common-dir'));
      const primary = path.dirname(common);
      const local = path.join(primary, '.agent', 'orchestrate.local.md');
      const bus = fs.readFileSync(local, 'utf8').match(/^- `session_bus_dir`: `([^`]+)`/m)?.[1];
      if (bus) stateDir = path.dirname(path.resolve(primary, bus.replace(/^~(?=\/|$)/, os.homedir())));
    } catch { /* An explicit state directory is required without project configuration. */ }
  }
  if (!stateDir) fail(3, 'No shared state configured; set AGENT_STATE_DIR or session_bus_dir in the neutral local companion');
  stateDir = path.resolve(stateDir.replace(/^~(?=\/|$)/, os.homedir()));
  const root = path.join(stateDir, 'named-sessions');
  const registry = path.join(root, 'registry.json');
  lock = path.join(root, '.lock');
  const sid = opt['session-id'] || process.env.AGENT_SESSION_ID || process.env.CODEX_THREAD_ID || process.env.CLAUDE_CODE_SESSION_ID || process.env.PI_SESSION_ID;
  const harness = opt.harness || process.env.AGENT_HARNESS || (process.env.CODEX_THREAD_ID ? 'codex' : process.env.CLAUDE_CODE_SESSION_ID ? 'claude' : process.env.PI_SESSION_ID ? 'pi' : undefined);
  const identity = () => {
    if (!safe(sid) || !safe(harness)) fail(2, 'Provide a stable --session-id and --harness');
    return [sid, harness];
  };
  if (cmd === 'boot') identity();
  if (cmd === 'current' && (!sid || !harness)) fail(3, 'No stable session identity for named lookup');
  if (cmd === 'boot') {
    if (!['pm', 'tl'].includes(need('role'))) fail(2, 'Boot requires role pm or tl');
    if (opt.role === 'tl' && !safe(need('lane'))) fail(2, 'TL boot requires a safe lane');
    if (opt.role === 'pm' && opt.lane) fail(2, 'PM has no lane; omit --lane');
  }
  if (cmd === 'claim') { need('ticket'); need('confirmation'); }
  if (cmd === 'release') { need('quiescence'); need('branch'); }
  if (['send', 'broadcast'].includes(cmd)) { need('subject'); need('body-file'); }
  if (cmd !== 'boot' && !fs.existsSync(root)) fail(3, 'No named registration');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); locked = true; break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; await new Promise(resolve => setTimeout(resolve, 20)); }
  }
  if (!locked) fail(6, 'State lock is occupied; inspect the lock and durable registry with the owner before manual recovery; never reclaim by PID or age', { lock });
  let db;
  if (fs.existsSync(registry)) {
    try { db = JSON.parse(fs.readFileSync(registry, 'utf8')); } catch { fail(4, 'Unreadable registry; inspect and restore before continuing', { registry }); }
  } else {
    if (fs.readdirSync(root).some(f => f !== '.lock')) fail(4, 'Incomplete registry; inspect state before recovery', { root });
    db = { version: 1, sessions: [], claims: [], messages: [] };
  }
  const paths = (s) => {
    const dir = path.join(stateDir, 'session-bus', s.role === 'pm' ? 'pm' : `tl-${s.lane}`, s.name.toLowerCase(), s.generation);
    return { inbox: path.join(dir, 'inbox'), archive: path.join(dir, 'inbox', 'archive'), comment_cursor: path.join(dir, 'cursors.json'), event_cursors: path.join(dir, 'event-cursors'), merged_seen: path.join(dir, 'merged-seen'), notes: path.join(dir, 'notes.md'), cursors: path.join(dir, 'cursors.json'), watchlist: path.join(dir, 'watchlist'), self_events: path.join(dir, 'self-events'), rules_stamp: path.join(dir, 'rules.stamp') };
  };
  const validSession = s => s && names.includes(s.name) && ['pm', 'tl'].includes(s.role) && (s.role === 'pm' ? s.lane === null : safe(s.lane)) && safe(s.session_id) && safe(s.harness) && /^[a-f0-9-]{36}$/.test(s.generation) && ['active', 'ended'].includes(s.status);
  if (db?.version !== 1 || !Array.isArray(db.sessions) || !Array.isArray(db.claims) || !Array.isArray(db.messages) || !db.sessions.every(validSession)) fail(4, 'Malformed registry', { registry });
  const active = () => db.sessions.filter(s => s.status === 'active');
  if (new Set(active().map(s => s.name)).size !== active().length || new Set(active().map(s => s.harness + '/' + s.session_id)).size !== active().length || new Set(db.sessions.map(s => s.generation)).size !== db.sessions.length) fail(4, 'Conflicting session registry');
  const sessionByGeneration = g => active().find(s => s.generation === g);
  if (!db.claims.every(c => c && typeof c.ticket === 'string' && c.ticket && Array.isArray(c.resources) && c.resources.every(r => typeof r === 'string' && r) && Array.isArray(c.prs) && c.prs.every(p => typeof p === 'string' && p) && sessionByGeneration(c.generation) && typeof c.confirmation === 'string' && c.confirmation) || new Set(db.claims.map(c => c.ticket)).size !== db.claims.length || new Set(db.claims.flatMap(c => c.resources)).size !== db.claims.flatMap(c => c.resources).length || new Set(db.claims.flatMap(c => c.prs)).size !== db.claims.flatMap(c => c.prs).length) fail(4, 'Malformed or conflicting ownership registry');
  if (!db.messages.every(m => m && /^[a-f0-9-]{36}$/.test(m.id) && db.sessions.some(s => s.generation === m.recipient) && typeof m.body === 'string' && typeof m.subject === 'string' && ['pending', 'archived'].includes(m.status) && db.sessions.some(s => s.generation === m.sender))) fail(4, 'Malformed message registry');
  const view = s => ({ ...s, paths: paths(s), claims: db.claims.filter(c => c.generation === s.generation) });
  const current = () => { identity(); const s = active().find(s => s.session_id === sid && s.harness === harness); if (!s) fail(3, 'No active named registration'); return s; };
  const actor = () => {
    const ownerId = opt['owner-session-id'] || process.env.AGENT_OWNER_SESSION_ID;
    const ownerHarness = opt['owner-harness'] || process.env.AGENT_OWNER_HARNESS;
    const generation = opt['owner-generation'] || process.env.AGENT_OWNER_GENERATION || opt.generation || process.env.AGENT_SESSION_GENERATION;
    if ((ownerId && !ownerHarness) || (!ownerId && ownerHarness)) fail(2, 'Assigned owner requires both session ID and harness');
    if (!ownerId) identity();
    const s = active().find(s => s.session_id === (ownerId || sid) && s.harness === (ownerHarness || harness));
    if (!s || !generation || s.generation !== generation) fail(5, 'Stale or missing owner generation');
    return s;
  };
  const resolve = name => { if (!names.includes(name)) fail(2, 'Unknown session name'); const s = active().find(s => s.name === name); if (!s) fail(3, 'Name is not active'); return s; };
  const ownerClaim = () => { if (!!opt.ticket === !!opt.pr) fail(2, 'Provide exactly one --ticket or --pr'); return db.claims.find(c => opt.ticket ? c.ticket === opt.ticket : c.prs.includes(opt.pr)); };
  const owns = (s, c) => { if (!c) fail(3, 'Ticket or PR is unowned'); if (c.generation !== s.generation) fail(5, 'Ownership conflict', { owner: view(sessionByGeneration(c.generation)) }); };
  const save = () => {
    const tmp = registry + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(db, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, registry);
    const directory = fs.openSync(root, 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  };
  const materialize = () => {
    for (const s of db.sessions) {
      const p = paths(s);
      for (const dir of [p.inbox, p.archive, p.self_events, p.event_cursors]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    for (const m of db.messages) {
      const inbox = paths(db.sessions.find(s => s.generation === m.recipient)).inbox;
      const pending = path.join(inbox, m.id + '.md');
      const target = m.status === 'pending' ? pending : path.join(inbox, 'archive', m.id + '.md');
      if (!fs.existsSync(target)) {
        const temporary = target + '.tmp';
        fs.writeFileSync(temporary, `---\nfrom: ${JSON.stringify(m.from)}\nsubject: ${JSON.stringify(m.subject)}\nrefs: ${JSON.stringify(m.ticket || '')}\n---\n${m.body}\n`, { mode: 0o600 });
        fs.renameSync(temporary, target);
      }
      if (m.status === 'archived' && fs.existsSync(pending)) fs.unlinkSync(pending);
    }
  };
  let result = {};
  let changed = false;
  switch (cmd) {
    case 'boot': {
      let s = active().find(s => s.session_id === sid && s.harness === harness);
      if (s && (s.role !== opt.role || s.lane !== (opt.lane || null))) fail(5, 'Existing session role or lane differs; retain it until explicit end', { session: view(s) });
      if (!s) {
        const name = names.find(n => !active().some(s => s.name === n));
        if (!name) fail(5, 'Session name pool exhausted; an owner must explicitly end a session');
        s = { name, role: opt.role, lane: opt.lane || null, session_id: sid, harness, generation: randomUUID(), status: 'active', started_at: Date.now() };
        db.sessions.push(s); changed = true;
      }
      result.session = view(s); break;
    }
    case 'current': result.session = view(current()); break;
    case 'list': result.sessions = active().map(view); break;
    case 'resolve': result.session = view(resolve(need('name'))); break;
    case 'owner': case 'check-owner': {
      const c = ownerClaim(); if (!c) fail(3, 'Ticket or PR is unowned');
      if (cmd === 'check-owner') owns(actor(), c);
      result = { session: view(sessionByGeneration(c.generation)), claim: c }; break;
    }
    case 'claim': {
      const s = actor(); const resources = [...new Set(opt.resource || [])];
      if (resources.some(r => !r.trim())) fail(2, 'Resource keys must be nonempty');
      const existing = db.claims.find(c => c.ticket === opt.ticket);
      if (existing?.generation === s.generation && JSON.stringify([...existing.resources].sort()) === JSON.stringify([...resources].sort())) { result = { session: view(s), claim: existing }; break; }
      const conflict = db.claims.find(c => c.ticket === opt.ticket || c.resources.some(r => resources.includes(r)));
      if (conflict) fail(5, 'Ticket or resource already claimed', { owner: view(sessionByGeneration(conflict.generation)), claim: conflict });
      const c = { ticket: opt.ticket, resources, confirmation: opt.confirmation, generation: s.generation, prs: [] };
      db.claims.push(c); changed = true; result = { session: view(s), claim: c }; break;
    }
    case 'associate-pr': {
      const s = actor(); const ticket = need('ticket'); const pr = need('pr');
      const c = db.claims.find(c => c.ticket === ticket); owns(s, c);
      const other = db.claims.find(c => c.prs.includes(pr));
      if (other && other !== c) fail(5, 'PR already associated', { owner: view(sessionByGeneration(other.generation)) });
      if (!c.prs.includes(pr)) c.prs.push(pr);
      changed = true; result = { session: view(s), claim: c }; break;
    }
    case 'release': {
      const s = actor(); const c = db.claims.find(c => c.ticket === need('ticket')); owns(s, c);
      (s.releases ??= []).push({ ...c, quiescence: opt.quiescence, branch: opt.branch, released_at: Date.now() });
      db.claims = db.claims.filter(x => x !== c); changed = true; result.session = view(s); break;
    }
    case 'end': {
      const s = actor();
      if (db.claims.some(c => c.generation === s.generation) || db.messages.some(m => m.recipient === s.generation && m.status === 'pending') || (fs.existsSync(paths(s).inbox) && fs.readdirSync(paths(s).inbox).some(f => f !== 'archive'))) fail(5, 'Session has outstanding ownership or pending inbox work');
      s.status = 'ended'; s.ended_at = Date.now(); s.quiescence = opt.quiescence; s.branch = opt.branch;
      changed = true; result.session = view(s); break;
    }
    case 'send': case 'broadcast': {
      const s = actor(); let recipients;
      if (cmd === 'broadcast') recipients = active().filter(r => r.lane === need('lane') && r.generation !== s.generation);
      else if (opt.ticket) { const c = db.claims.find(c => c.ticket === opt.ticket); if (c) recipients = [sessionByGeneration(c.generation)]; else if (opt.triage) recipients = [resolve(opt.triage)]; else fail(3, 'Ticket is unowned; choose an explicit triage recipient'); }
      else recipients = [resolve(need('to'))];
      const body = fs.readFileSync(opt['body-file'], 'utf8');
      if (body.length > 65536 || opt.subject.length > 300 || /[\r\n]/.test(opt.subject)) fail(2, 'Message exceeds limits or subject contains a newline');
      result.messages = recipients.map(r => {
        const m = { id: randomUUID(), sender: s.generation, recipient: r.generation, from: `${s.name} (${s.role}${s.lane ? '/' + s.lane : ''})`, subject: opt.subject, body, ticket: opt.ticket || null, status: 'pending', sent_at: Date.now() };
        db.messages.push(m); return { id: m.id, session: view(r), path: path.join(paths(r).inbox, m.id + '.md') };
      }); changed = true; break;
    }
    case 'archive-message': {
      const s = actor(); const m = db.messages.find(m => m.id === need('message'));
      if (!m) fail(3, 'Message not found');
      if (m.recipient !== s.generation) fail(5, 'Message belongs to another session');
      m.status = 'archived'; changed = true; result.message = m.id; break;
    }
  }
  if (changed) save();
  if (changed || cmd === 'boot') materialize();
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (e) {
  console.error(JSON.stringify({ ok: false, code: Number.isInteger(e.code) ? e.code : 4, error: e.message, ...e.detail }));
  process.exitCode = Number.isInteger(e.code) ? e.code : 4;
} finally {
  if (locked) fs.rmdirSync(lock);
}
