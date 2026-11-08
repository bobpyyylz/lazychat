# Matrix Client

A small Matrix client for Windows, focused on text chat, encrypted messaging and a straightforward interface. Built with Tauri, Rust, React and TypeScript.

**Current version: 1.0.0-rc.1.** This is a release candidate. Automated messaging tests passed, and encrypted group messages were manually verified with Element after restarting the app. Installation, upgrade and uninstall still need testing on a clean Windows machine.

## What works

- Browser sign-in for matrix.org and compatible password sign-in for other homeservers.
- Direct messages, joined rooms, invitations and joining rooms by ID or alias.
- Space navigation with separate Open and Join controls for child rooms.
- Matrix end-to-end encryption through the Matrix Rust SDK.
- Recovery using an existing Matrix recovery key.
- Saved sessions and encryption keys protected using Windows DPAPI and encrypted SDK stores.
- In-session drafts and transaction IDs retained when a send fails, so an unchanged message can be retried.

Presence is set to offline. The app does not send typing notifications or read receipts, and does not include analytics or automatically download media.

## Getting started

1. Download the Windows x64 package from this repository's **Releases** page when a release is available.
2. Extract the ZIP. Run the setup executable, or use **MatrixClient.exe** if WebView2 is already installed. The installer can download WebView2 when needed.
3. For a matrix.org account, leave the server as **https://matrix.org** and choose **Sign in with browser**.
4. After syncing, open **Encryption setup** and use your existing recovery key to recover your encryption secrets and verify this device.
5. Select a room. Press **Enter** to send or **Shift+Enter** for a new line.

For a new account, configure encryption recovery in Element first. Creating a recovery setup and emoji/QR verification are not implemented here yet.

Only one copy of the app can use the saved session at a time. Save any unsent drafts before closing an older copy. Drafts are kept in memory and do not survive closing the app.

## Building

The supported build target is Windows x64. You need Node.js 24, Rust 1.99.1, Visual Studio 2022 C++ tools, Windows SDK 10.0.22621.0 and WebView2. Python 3.11 or later is also needed to package a release.

From the repository root:

~~~powershell
npm.cmd --prefix apps/client ci
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows.ps1 build
~~~

This creates a local development build under **artifacts**. For release packaging, dependency source preparation and tests, see [BUILDING.md](BUILDING.md).

## Known limitations

This release handles text messaging. Attachments, calls, reactions, edits, threads, notifications, automatic updates, creating new chats/rooms and interactive device verification are not implemented.

The timeline loads up to 100 recent events while connected; there is no offline history interface or history pagination yet. CSS theme loading, Linux and Android support are planned. An additional encryption layer is an experiment under consideration, not a feature of this release.

The Windows executable and installer are unsigned. This project has not had an independent security audit. Standard Matrix encryption does not hide all metadata from homeservers, and Windows DPAPI does not protect an unlocked app from malware running as the same Windows user.

## Problems and fixes

| Problem | What to try |
| --- | --- |
| I can send DMs but cannot chat in a space. | A space groups rooms; it is not the conversation itself. Open the space and choose **Open** or **Join** beside a child room. Joining a space does not join all its rooms. |
| Joining a room returns M_FORBIDDEN. | Check which account is signed in. A private room may need an invitation for that exact account. Being in the parent space does not grant access. |
| Encrypted sending is blocked because the device is unverified. | Open **Encryption setup** and recover with the existing recovery key. If recovery has not been set up, do that in Element first. |
| Sending reports a changed identity or missing cross-signing. | Check the affected account and device verification in a trusted client such as Element. Resolve the verification issue there before retrying; the app does not bypass that check. |
| A message was not confirmed sent. | Check connectivity and the error shown. Leave the draft unchanged and retry in the same session to reuse its transaction ID. Check the timeline before composing a replacement. |
| Older encrypted messages cannot be read. | Recover the existing encryption keys. History can only be decrypted if the required keys are available; a missing old key does not necessarily mean new messages will fail. |
| Opening the app does not produce another window. | Look for an older running copy. Save its drafts and close it, then open the new build. Only one process can access the encryption store. |
| The portable app cannot start because WebView2 is missing. | Use the supplied installer, which can download WebView2. An internet connection is needed for that download. |
| Sign-out fails while offline. | Reconnect and retry. The app keeps the saved login until server sign-out succeeds or the server reports that the token is already invalid. |

If a problem persists, open an issue with the app version, Windows version, steps to reproduce, expected behavior and the error text. Remove private messages and account details from screenshots or logs. Never include passwords, access tokens, recovery keys or your app-data directory.

## Testing

The current checks cover Rust unit tests, React regression tests, fixture protocol tests and an integration harness using the real Matrix SDK with synthetic accounts. The harness checks encrypted exchange, session restoration, transaction retries, space handling and server errors. A live group-message check with Element also passed.

These checks cover specific behavior; they are not proof that every homeserver or account configuration works. See [VALIDATION.md](docs/VALIDATION.md) for results and [the release review](docs/RELEASE_REVIEW.md) for remaining checks.

## Development and AI assistance

AI tools, including OpenAI Codex, have been used to write code, implement features, debug issues, review changes, write tests and prepare documentation. Manual testing has also been used, including checking encrypted messages against Element. AI assistance and passing tests do not replace an independent security review.

Bug reports and focused fixes are welcome. Include reproduction steps and explain how a change was tested. The [architecture notes](docs/ARCHITECTURE.md) and [security notes](docs/SECURITY.md) describe the design; other planning documents may discuss features that have not shipped.

## License

Project code is licensed under **GPL-3.0-only**. See [LICENSE](LICENSE) and [COPYRIGHT.md](COPYRIGHT.md).

Dependencies retain their own licenses. Supplemental notices are in **third-party-notices**; the release package includes the full dependency notice collection and matching source archive. Keep the source, build instructions and license files with the binaries when sharing the complete release package.
