import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from './server.mjs';

test('fixture isolates sessions, relays opaque events, and deduplicates sends', async () => {
  const fixture = await createFixture();
  try {
    async function request(path, { method = 'GET', token, body } = {}) {
      const response = await fetch(`${fixture.baseUrl}${path}`, { method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: await response.json() };
    }
    const prefix = '/_matrix/client/v3';
    const login = async user => (await request(`${prefix}/login`, { method: 'POST', body: {
      type: 'm.login.password', identifier: { type: 'm.id.user', user }, password: 'test-password',
    } })).body;
    const alice = await login('alice');
    const bob = await login('bob');
    assert.notEqual(alice.access_token, bob.access_token);
    assert.equal((await request(`${prefix}/sync`)).status, 401);
    const first = await request(`${prefix}/sync`, { token: bob.access_token });
    assert.equal(first.status, 200);
    const room = first.body.rooms.join['!encrypted:fixture.local'];
    assert.ok(room.state.events.some(event => event.type === 'm.room.encryption'));
    const roomPath = encodeURIComponent('!encrypted:fixture.local');
    const rejected = await request(`${prefix}/rooms/${roomPath}/send/m.room.message/plaintext`, { method: 'PUT', token: alice.access_token, body: { msgtype: 'm.text', body: 'should not pass' } });
    assert.equal(rejected.status, 400);
    const encrypted = { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'opaque-test-data', session_id: 'synthetic' };
    const sent = await request(`${prefix}/rooms/${roomPath}/send/m.room.encrypted/txn1`, { method: 'PUT', token: alice.access_token, body: encrypted });
    const retry = await request(`${prefix}/rooms/${roomPath}/send/m.room.encrypted/txn1`, { method: 'PUT', token: alice.access_token, body: encrypted });
    assert.equal(sent.body.event_id, retry.body.event_id);
    const next = await request(`${prefix}/sync?since=${first.body.next_batch}`, { token: bob.access_token });
    const events = next.body.rooms.join['!encrypted:fixture.local'].timeline.events;
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].content, encrypted);
    const stats = await request('/__fixture/stats');
    assert.equal(stats.body.rooms.find(item => item.encrypted).events[0].containsBody, false);
    await request(`${prefix}/logout`, { method: 'POST', token: alice.access_token, body: {} });
    assert.equal((await request(`${prefix}/sync`, { token: alice.access_token })).status, 401);
    assert.equal((await request(`${prefix}/sync`, { token: bob.access_token })).status, 200);
  } finally { await fixture.close(); }
});

test('fixture claims one-time keys once and directs to-device events', async () => {
  const fixture = await createFixture();
  try {
    async function request(path, method, body, token) {
      const response = await fetch(`${fixture.baseUrl}/_matrix/client/v3${path}`, {
        method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(response.status, 200);
      return response.json();
    }
    const login = user => request('/login', 'POST', { type: 'm.login.password', identifier: { type: 'm.id.user', user }, password: 'test-password' });
    const alice = await login('alice');
    const bob = await login('bob');
    const deviceKeys = { user_id: bob.user_id, device_id: bob.device_id, algorithms: ['m.olm.v1.curve25519-aes-sha2'], keys: {}, signatures: {} };
    const key = { key: 'synthetic-public-key', signatures: {} };
    const upload = await request('/keys/upload', 'POST', { device_keys: deviceKeys, one_time_keys: { 'signed_curve25519:abc': key } }, bob.access_token);
    assert.equal(upload.one_time_key_counts.signed_curve25519, 1);
    const queried = await request('/keys/query', 'POST', { device_keys: { [bob.user_id]: [] } }, alice.access_token);
    assert.deepEqual(queried.device_keys[bob.user_id][bob.device_id], deviceKeys);
    const query = { one_time_keys: { [bob.user_id]: { [bob.device_id]: 'signed_curve25519' } } };
    const first = await request('/keys/claim', 'POST', query, alice.access_token);
    assert.deepEqual(first.one_time_keys[bob.user_id][bob.device_id]['signed_curve25519:abc'], key);
    const second = await request('/keys/claim', 'POST', query, alice.access_token);
    assert.deepEqual(second.one_time_keys[bob.user_id], {});
    const before = await request('/sync', 'GET', undefined, bob.access_token);
    await request('/sendToDevice/m.room.encrypted/keytx', 'PUT', { messages: { [bob.user_id]: { [bob.device_id]: { ciphertext: 'opaque-key-envelope' } } } }, alice.access_token);
    const next = await request(`/sync?since=${before.next_batch}`, 'GET', undefined, bob.access_token);
    assert.deepEqual(next.to_device.events, [{ type: 'm.room.encrypted', sender: alice.user_id, content: { ciphertext: 'opaque-key-envelope' } }]);
    const own = await request(`/sync?since=${before.next_batch}`, 'GET', undefined, alice.access_token);
    assert.deepEqual(own.to_device.events, []);
  } finally { await fixture.close(); }
});
