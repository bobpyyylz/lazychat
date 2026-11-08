# Messaging verification

`matrix-fixture/server.mjs` is a small in-memory Matrix HTTP fixture, restricted to loopback. It has synthetic accounts and implements only the endpoints needed by this prototype. It is **not** a homeserver suitable for real accounts, persistence, federation, or exposure to a network.

The fixture does not implement message encryption: the real Matrix Rust SDK clients encrypt and decrypt data. The fixture relays keys and stores the resulting opaque events. This lets the integration harness exercise actual SDK cryptography and restart behavior without real user credentials.

Run protocol-fixture checks:

```powershell
node --test tests/matrix-fixture/server.test.mjs
```

Run the Rust client integration harness:

```powershell
.\scripts\test-messaging.ps1
```

The Windows wrapper loads the project's C++/CMake/Rust build environment. The underlying `node scripts/test-messaging.mjs` runner can also run directly in a configured development shell. It starts an ephemeral fixture, runs the `client-core` `fixture_smoke` example, checks that encrypted-room transport contains ciphertext rather than plaintext body fields, prints non-secret aggregate request/event statistics, and closes the fixture. It uses the project-local Rust toolchain when installed. Any real server interoperability claims need separate tests against an actual Matrix homeserver and an established client.

For manual synthetic testing only:

```powershell
node tests/matrix-fixture/server.mjs
```

The fixture then listens at `http://127.0.0.1:18848`. Users are `alice` and `bob`, password `test-password`. Both are already members of `!plain:fixture.local` and `!encrypted:fixture.local`. All server state disappears when the process exits; remove/reset the corresponding test client profile before trying a fresh fixture session.

No Docker installation was found, and WSL reports that it is not installed. Synapse's official installation guide does not support native Windows. The fixture avoids changing the operating system while establishing a deterministic client test path.
