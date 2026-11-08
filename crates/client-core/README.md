# Matrix client core

Rust messaging layer shared by the native app. It uses `matrix-sdk` 0.19.1 for the Matrix protocol and encryption; it does not implement new cryptography.

The native host supplies a new store directory and cryptographically random secret for each fresh login. `export_session()` contains an access token: protect it together with the store secret using the platform secret facility. Never expose it through webview commands or logs. Restore that same session and directory with `Core::restore`; do not perform another login against an existing device database.

Run one cancellable loop of `sync_once()` while signed in. The SDK owns sync-token persistence and encryption requests. The host supplies backoff, cancellation and serialization of user operations. Initial synchronization populates room membership and encryption state. The core uses classic `/sync` for compatibility with homeservers that do not offer native sliding sync.

`rooms()` lists joined rooms and invitations. `messages()` reads up to 100 recent events, decrypts through the SDK, and returns plain text or an explicit unavailable-key placeholder. Rendering code must display these strings as text. `send_message()` accepts a caller-generated transaction ID so an uncertain send can be retried without creating duplicate events.

Production connections require HTTPS. Browser login uses the SDK's temporary loopback callback listener, a five-minute timeout, and an external-browser callback from the host. Servers advertising preferred browser authentication are not offered a password downgrade. Presence is sent as offline; the core does not send typing notices or read receipts.

Encrypted sends require the local device to be cross-signed. The SDK's `IdentityBasedStrategy` excludes recipient devices that their owner has not signed and rejects changes to identities previously verified by this client. A signed device is not the same as a contact personally verified by the user. Recovery imports existing secret-storage keys through the SDK; it does not reset identity or replace backups. Interactive device/contact verification and first-account encryption setup are not exposed by this prototype, so a user without existing recovery secrets may need a mature Matrix client to complete setup first. Unencrypted rooms remain usable and are identified in the room DTO.

SQLite record encryption protects SDK records using the supplied secret. This is not full-disk encryption and does not hide all file sizes/schema/metadata. Tokens remain in the host's separate protected session. The core makes no guarantee against malware already running as the OS user.

## Validation

From the workspace root:

```text
cargo test -p client-core
node scripts/test-messaging.mjs
```

The integration runner enables the `test-fixture` feature and starts a synthetic loopback server. The real SDK generates keys, encrypts messages, decrypts them for a second account, and restores the same device from an encrypted store. It also checks plaintext messaging, retry transaction IDs, rejection before local verification, wrong-secret rejection, and logout. Fixture-only identity bootstrapping is restricted to loopback and is absent from a default production build. The fixture is not a real homeserver and does not prove production federation, SSO, recovery compatibility, or security-audit coverage.
