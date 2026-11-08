/**
 * Minimal, in-memory Matrix client/server protocol fixture.
 * NOT a production homeserver: no federation, persistence, real authentication,
 * or full protocol semantics. Binds only to IPv4 loopback and uses synthetic data.
 * Real Matrix SDKs provide cryptography; this server stores opaque encrypted events.
 */
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';

const DOMAIN = 'fixture.local';
const USERS = ['alice', 'bob'].map(name => `@${name}:${DOMAIN}`);
const PASSWORD = 'test-password';

export async function createFixture({ port = 0 } = {}) {
  const changes = new EventEmitter();
  const devices = new Map();
  const tokens = new Map();
  const signing = new Map();
  const accountData = new Map(USERS.map(user => [user, new Map()]));
  const transactions = new Map();
  const backupVersions = new Map();
  const requests = new Map();
  const unhandled = new Set();
  let sequence = 1;
  let nextDevice = 1;
  let nextEvent = 1;
  let baseUrl;
  const bump = () => { sequence += 1; changes.emit('change'); return sequence; };
  const event = (type, content, sender = USERS[0], stateKey) => ({
    type, content, sender, event_id: `$fixture${nextEvent++}:${DOMAIN}`,
    origin_server_ts: Date.now(), ...(stateKey === undefined ? {} : { state_key: stateKey }),
  });
  const rooms = new Map();
  for (const encrypted of [false, true]) {
    const id = `!${encrypted ? 'encrypted' : 'plain'}:${DOMAIN}`;
    const state = [
      event('m.room.create', { creator: USERS[0], room_version: '10' }, USERS[0], ''),
      event('m.room.name', { name: encrypted ? 'Encrypted fixture' : 'Plain fixture' }, USERS[0], ''),
      event('m.room.join_rules', { join_rule: 'invite' }, USERS[0], ''),
      event('m.room.history_visibility', { history_visibility: 'shared' }, USERS[0], ''),
      event('m.room.power_levels', { users: { [USERS[0]]: 100 }, users_default: 0,
        events_default: 0, state_default: 50, ban: 50, kick: 50, redact: 50, invite: 0 }, USERS[0], ''),
      ...USERS.map(user => event('m.room.member', { membership: 'join', displayname: user.split(':')[0].slice(1) }, user, user)),
    ];
    if (encrypted) state.push(event('m.room.encryption', { algorithm: 'm.megolm.v1.aes-sha2', rotation_period_ms: 604800000, rotation_period_msgs: 100 }, USERS[0], ''));
    rooms.set(id, { id, encrypted, state, timeline: [], members: new Set(USERS) });
  }

  rooms.set('!space:fixture.local', { id: '!space:fixture.local', encrypted: false,
    state: [event('m.room.create', { creator: USERS[0], room_version: '10', type: 'm.space' }, USERS[0], ''),
      event('m.room.name', { name: 'Fixture space' }, USERS[0], ''),
      ...USERS.map(user => event('m.room.member', { membership: 'join' }, user, user))],
    timeline: [], members: new Set(USERS) });

  function counts(device) {
    return { signed_curve25519: Object.keys(device.oneTimeKeys).filter(key => key.startsWith('signed_curve25519:')).length };
  }
  function addSignatures(target, incoming = {}) {
    target.signatures ??= {};
    for (const [signer, signatures] of Object.entries(incoming)) target.signatures[signer] = { ...target.signatures[signer], ...signatures };
  }
  function fail(response, status, errcode, error) { json(response, status, { errcode, error }); }
  function json(response, status, body) {
    if (response.writableEnded) return;
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(body));
  }
  async function bodyOf(request) {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) throw new Error('Fixture request too large');
      chunks.push(chunk);
    }
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  }
  async function waitForChange(timeout) {
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); changes.off('change', done); resolve(); };
      const timer = setTimeout(done, timeout);
      changes.once('change', done);
    });
  }
  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, baseUrl);
      const path = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const method = request.method;
      const metric = `${method} ${url.pathname}`;
      requests.set(metric, (requests.get(metric) ?? 0) + 1);
      if (url.pathname === '/__fixture/health') return json(response, 200, { fixture: true, baseUrl });
      if (url.pathname === '/__fixture/stats') {
        return json(response, 200, { fixture: true, users: USERS, devices: devices.size,
          rooms: [...rooms.values()].map(room => ({ id: room.id, encrypted: room.encrypted,
            events: room.timeline.map(item => ({ type: item.event.type, id: item.event.event_id,
              containsBody: Object.hasOwn(item.event.content, 'body') })) })),
          unhandled: [...unhandled], requests: Object.fromEntries(requests) });
      }
      if (url.pathname === '/.well-known/matrix/client') return json(response, 200, { 'm.homeserver': { base_url: baseUrl } });
      if (url.pathname === '/_matrix/client/versions') return json(response, 200, { versions: ['r0.6.1', 'v1.1', 'v1.11', 'v1.12'], unstable_features: {} });
      if (path[0] !== '_matrix' || path[1] !== 'client') return fail(response, 404, 'M_UNRECOGNIZED', 'Fixture route not implemented');
      const route = path.slice(3);
      const payload = ['POST', 'PUT'].includes(method) ? await bodyOf(request) : {};
      // Matrix alias resolution is a public endpoint; the SDK omits auth.
      if (route[0] === 'directory' && route[1] === 'room' && method === 'GET') {
        const id = route[2]?.startsWith('#') ? `!${route[2].slice(1)}` : '';
        return rooms.has(id) ? json(response, 200, { room_id: id, servers: [DOMAIN] }) : fail(response, 404, 'M_NOT_FOUND', 'No fixture alias');
      }
      if (route[0] === 'login' && method === 'GET') return json(response, 200, { flows: [{ type: 'm.login.password' }] });
      if (route[0] === 'login' && method === 'POST') {
        let user = payload.identifier?.user ?? payload.user ?? '';
        if (!user.startsWith('@')) user = `@${user}:${DOMAIN}`;
        if (!USERS.includes(user) || payload.password !== PASSWORD) return fail(response, 403, 'M_FORBIDDEN', 'Use synthetic fixture credentials only');
        const id = payload.device_id ?? `FIXTURE${nextDevice++}`;
        const key = `${user}|${id}`;
        let device = devices.get(key);
        if (!device) {
          device = { user, id, deviceKeys: undefined, oneTimeKeys: {}, fallbackKeys: {}, toDevice: [], displayName: payload.initial_device_display_name ?? id };
          devices.set(key, device);
        }
        const token = `fixture-token-${nextDevice++}`;
        tokens.set(token, device);
        bump();
        return json(response, 200, { user_id: user, device_id: id, access_token: token, home_server: DOMAIN, well_known: { 'm.homeserver': { base_url: baseUrl } } });
      }
      const token = request.headers.authorization?.replace(/^Bearer /, '') ?? url.searchParams.get('access_token');
      const device = tokens.get(token);
      if (!device) return fail(response, 401, 'M_UNKNOWN_TOKEN', 'Unknown fixture session');
      const userDevices = user => [...devices.values()].filter(candidate => candidate.user === user);
      if (route.join('/') === 'account/whoami') return json(response, 200, { user_id: device.user, device_id: device.id, is_guest: false });
      if (route[0] === 'capabilities') return json(response, 200, { capabilities: { 'm.room_versions': { default: '10', available: { '10': 'stable' } } } });
      if (route[0] === 'logout') { tokens.delete(token); return json(response, 200, {}); }
      if (route[0] === 'devices' && route.length === 1) return json(response, 200, { devices: userDevices(device.user).map(item => ({ device_id: item.id, display_name: item.displayName, last_seen_ts: Date.now() })) });
      if (route[0] === 'profile') return json(response, 200, { displayname: route[1].split(':')[0].slice(1) });
      if (route[0] === 'pushrules') return json(response, 200, { global: { content: [], override: [], room: [], sender: [], underride: [] } });
      if (route[0] === 'presence') return json(response, 200, {});
      if (route[0] === 'user' && route[2] === 'filter') return json(response, 200, { filter_id: 'fixture' });
      if (route[0] === 'user' && route[2] === 'account_data') {
        if (route[1] !== device.user) return fail(response, 403, 'M_FORBIDDEN', 'Wrong account');
        const store = accountData.get(device.user);
        if (method === 'PUT') { store.set(route[3], payload); bump(); return json(response, 200, {}); }
        return store.has(route[3]) ? json(response, 200, store.get(route[3])) : fail(response, 404, 'M_NOT_FOUND', 'No account data');
      }
      if (route[0] === 'keys' && route[1] === 'upload') {
        if (payload.device_keys) device.deviceKeys = payload.device_keys;
        Object.assign(device.oneTimeKeys, payload.one_time_keys ?? {});
        Object.assign(device.fallbackKeys, payload.fallback_keys ?? {});
        bump();
        return json(response, 200, { one_time_key_counts: counts(device) });
      }
      if (route[0] === 'keys' && route[1] === 'query') {
        const result = { device_keys: {}, failures: {}, master_keys: {}, self_signing_keys: {}, user_signing_keys: {} };
        for (const [user, ids] of Object.entries(payload.device_keys ?? {})) {
          result.device_keys[user] = {};
          for (const candidate of userDevices(user)) if (candidate.deviceKeys && (!ids.length || ids.includes(candidate.id))) result.device_keys[user][candidate.id] = candidate.deviceKeys;
          const keys = signing.get(user);
          if (keys) for (const [singular, plural] of [['master_key', 'master_keys'], ['self_signing_key', 'self_signing_keys'], ['user_signing_key', 'user_signing_keys']]) if (keys[singular]) result[plural][user] = keys[singular];
        }
        return json(response, 200, result);
      }
      if (route[0] === 'keys' && route[1] === 'claim') {
        const result = { one_time_keys: {}, failures: {} };
        for (const [user, ids] of Object.entries(payload.one_time_keys ?? {})) {
          result.one_time_keys[user] = {};
          for (const [id, algorithm] of Object.entries(ids)) {
            const target = devices.get(`${user}|${id}`);
            if (!target) continue;
            const key = Object.keys(target.oneTimeKeys).find(name => name.startsWith(`${algorithm}:`));
            const fallback = Object.keys(target.fallbackKeys).find(name => name.startsWith(`${algorithm}:`));
            if (key) { result.one_time_keys[user][id] = { [key]: target.oneTimeKeys[key] }; delete target.oneTimeKeys[key]; }
            else if (fallback) result.one_time_keys[user][id] = { [fallback]: target.fallbackKeys[fallback] };
          }
        }
        return json(response, 200, result);
      }
      if (route[0] === 'keys' && route[1] === 'changes') return json(response, 200, { changed: USERS, left: [] });
      if (route[0] === 'keys' && route[1] === 'device_signing') {
        signing.set(device.user, payload); bump(); return json(response, 200, {});
      }
      if (route[0] === 'keys' && route[1] === 'signatures') {
        for (const [user, entries] of Object.entries(payload)) {
          for (const [id, signed] of Object.entries(entries)) {
            const target = devices.get(`${user}|${id}`);
            if (target?.deviceKeys) addSignatures(target.deviceKeys, signed.signatures);
            const keys = signing.get(user);
            if (keys) for (const key of Object.values(keys)) if (key?.keys && (Object.values(key.keys).includes(id) || Object.keys(key.keys).includes(id))) addSignatures(key, signed.signatures);
          }
        }
        bump(); return json(response, 200, { failures: {} });
      }
      if (route[0] === 'sendToDevice') {
        const tx = `${device.user}|${device.id}|toDevice|${route[2]}`;
        if (!transactions.has(tx)) {
          transactions.set(tx, true);
          const seq = bump();
          for (const [user, targets] of Object.entries(payload.messages ?? {})) for (const [id, content] of Object.entries(targets)) {
            for (const candidate of userDevices(user)) if (id === '*' || candidate.id === id) candidate.toDevice.push({ sequence: seq, event: { type: route[1], sender: device.user, content } });
          }
        }
        return json(response, 200, {});
      }
      if (route[0] === 'room_keys') {
        if (method === 'POST' && route[1] === 'version') { backupVersions.set(device.user, { ...payload, version: '1', count: 0, etag: '0' }); return json(response, 200, { version: '1' }); }
        if (method === 'PUT') return json(response, 200, { count: 0, etag: '0' });
        return backupVersions.has(device.user) ? json(response, 200, backupVersions.get(device.user)) : fail(response, 404, 'M_NOT_FOUND', 'No backup');
      }
      if (route[0] === 'sync') {
        const since = Number((url.searchParams.get('since') ?? 's0').slice(1)) || 0;
        if (since >= sequence) await waitForChange(Math.min(Number(url.searchParams.get('timeout')) || 250, 1500));
        const joined = {};
        for (const room of rooms.values()) {
          if (!room.members.has(device.user)) continue;
          joined[room.id] = { state: { events: since ? [] : room.state },
            timeline: { events: room.timeline.filter(item => item.sequence > since).map(item => item.event), limited: false, prev_batch: 't0' },
            ephemeral: { events: [] }, account_data: { events: [] }, unread_notifications: { highlight_count: 0, notification_count: 0 },
            summary: { 'm.joined_member_count': room.members.size, 'm.invited_member_count': 0 } };
        }
        return json(response, 200, { next_batch: `s${sequence}`, rooms: { join: joined, invite: {}, leave: {} },
          account_data: { events: [...accountData.get(device.user)].map(([type, content]) => ({ type, content })) },
          presence: { events: [] }, to_device: { events: device.toDevice.filter(item => item.sequence > since).map(item => item.event) },
          device_lists: { changed: USERS, left: [] }, device_one_time_keys_count: counts(device),
          device_unused_fallback_key_types: Object.keys(device.fallbackKeys).length ? ['signed_curve25519'] : [] });
      }
      if (route[0] === 'joined_rooms') return json(response, 200, { joined_rooms: [...rooms.values()].filter(room => room.members.has(device.user)).map(room => room.id) });
      if (route[0] === 'join' || (route[0] === 'rooms' && route[2] === 'join')) {
        const id = route[1].startsWith('#') ? `!${route[1].slice(1)}` : route[1];
        const room = rooms.get(id);
        if (!room) return fail(response, 404, 'M_NOT_FOUND', 'No fixture room');
        room.members.add(device.user); bump(); return json(response, 200, { room_id: room.id });
      }
      if (route[0] === 'rooms') {
        const room = rooms.get(route[1]);
        if (!room) return fail(response, 404, 'M_NOT_FOUND', 'No fixture room');
        if (!room.members.has(device.user)) return fail(response, 403, 'M_FORBIDDEN', 'Not a member');
        if (route[2] === 'hierarchy') return json(response, 200, { rooms: [...rooms.values()].map(child => ({
          room_id: child.id, name: child.state.find(e => e.type === 'm.room.name')?.content.name,
          num_joined_members: child.members.size, world_readable: false, guest_can_join: false,
          join_rule: 'invite', children_state: []
        })) });
        if (route[2] === 'members') return json(response, 200, { chunk: room.state.filter(item => item.type === 'm.room.member') });
        if (route[2] === 'joined_members') return json(response, 200, { joined: Object.fromEntries([...room.members].map(user => [user, { display_name: user.split(':')[0].slice(1) }])) });
        if (route[2] === 'state') {
          if (!route[3]) return json(response, 200, room.state);
          const match = room.state.find(item => item.type === route[3] && item.state_key === (route[4] ?? ''));
          return match ? json(response, 200, match.content) : fail(response, 404, 'M_NOT_FOUND', 'No state event');
        }
        if (route[2] === 'send') {
          if (route[4] === 'fixture-forbidden') return fail(response, 403, 'M_FORBIDDEN', 'Fixture room permission denied');
          // Test oracle: fail any attempted plaintext fallback in the encrypted
          // fixture room. Real homeservers need not enforce this client policy.
          if (room.encrypted && route[3] === 'm.room.message') return fail(response, 400, 'M_BAD_JSON', 'Fixture detected plaintext fallback in an encrypted room');
          const tx = `${device.user}|${device.id}|${room.id}|${route[4]}`;
          if (transactions.has(tx)) return json(response, 200, { event_id: transactions.get(tx) });
          const sent = event(route[3], payload, device.user);
          sent.unsigned = { transaction_id: route[4] };
          room.timeline.push({ sequence: bump(), event: sent });
          transactions.set(tx, sent.event_id);
          return json(response, 200, { event_id: sent.event_id });
        }
        if (route[2] === 'messages') {
          const all = room.timeline.map(item => ({ ...item.event, room_id: room.id }));
          const backward = url.searchParams.get('dir') !== 'f';
          const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 1000);
          return json(response, 200, { start: url.searchParams.get('from') ?? 't0', chunk: (backward ? all.toReversed() : all).slice(0, limit), state: room.state });
        }
        if (route[2] === 'event') {
          const found = room.timeline.find(item => item.event.event_id === route[3]);
          return found ? json(response, 200, { ...found.event, room_id: room.id }) : fail(response, 404, 'M_NOT_FOUND', 'No event');
        }
        if (['read_markers', 'receipt', 'typing'].includes(route[2])) return json(response, 200, {});
      }
      unhandled.add(`${method} /${route.join('/')}`);
      return fail(response, 404, 'M_UNRECOGNIZED', 'Fixture endpoint not implemented');
    } catch (error) {
      // Never print request content or key material, even in this synthetic fixture.
      json(response, 500, { errcode: 'M_UNKNOWN', error: `Fixture error: ${error.message}` });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, close: () => new Promise(resolve => { changes.emit('change'); server.close(resolve); server.closeAllConnections(); }) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await createFixture({ port: Number(process.env.MATRIX_FIXTURE_PORT ?? 18848) });
  console.log(`Synthetic Matrix fixture listening on ${fixture.baseUrl}; not a production homeserver.`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await fixture.close(); process.exit(0); });
}
