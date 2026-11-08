import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createFixture } from '../tests/matrix-fixture/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localCargo = path.join(root, '.tools', 'cargo', 'bin', process.platform === 'win32' ? 'cargo.exe' : 'cargo');
const cargo = existsSync(localCargo) ? localCargo : 'cargo';
const fixture = await createFixture();
console.log('Running client integration against a synthetic loopback fixture (not a production homeserver).');
try {
  const env = { ...process.env, MATRIX_FIXTURE_URL: fixture.baseUrl };
  if (existsSync(localCargo)) {
    env.CARGO_HOME = path.join(root, '.tools', 'cargo');
    env.RUSTUP_HOME = path.join(root, '.tools', 'rustup');
    env.PATH = `${path.dirname(localCargo)}${path.delimiter}${env.PATH ?? ''}`;
  }
  const child = spawn(cargo, ['run', '-p', 'client-core', '--features', 'test-fixture', '--example', 'fixture_smoke'], { cwd: root, env, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  if (code !== 0) process.exitCode = code ?? 1;
  const response = await fetch(`${fixture.baseUrl}/__fixture/stats`);
  const stats = await response.json();
  if (code === 0) {
    const encryptedRoom = stats.rooms.find(room => room.id === '!encrypted:fixture.local');
    if (!encryptedRoom?.events.length || encryptedRoom.events.some(event => event.type !== 'm.room.encrypted' || event.containsBody)) {
      throw new Error('The SDK harness did not produce only encrypted transport events in the encrypted fixture room.');
    }
    console.log('Transport check passed: encrypted fixture room contains ciphertext events without plaintext body fields.');
  }
  console.log(JSON.stringify({ fixtureStats: stats }, null, 2));
} finally {
  await fixture.close();
}
