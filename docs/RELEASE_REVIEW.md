# Matrix Client 1.0 release review

Status: Windows 1.0 release candidate. Automated checks and live group-message acceptance passed; clean-machine installation, upgrade and uninstall remain to be tested.

This build targets Windows x64 and existing Matrix accounts. It supports text messaging, rooms/spaces, existing-key recovery and saved sessions. Account registration, first-time encryption setup, emoji/QR verification, creating chats/rooms, attachments, calls, themes, Linux and Android are not included.

## Review fixes
- Patched vodozemac to 0.11.2 for the November 6 secret-zeroization advisory.
- Preserved drafts and retry IDs when sign-out fails.
- Allowed sign-out after the server has already revoked a token.
- Waited for browser-login cancellation before reading the final session state.
- Ignored stale space requests after navigation; joining now enables Open.
- Used zeroize for the temporary Windows DPAPI plaintext buffer.
- Added a compile-time guard against enabling test-fixture in the desktop app.
- Formatted code consistently and kept comments focused on behavior and constraints.

## Before stable 1.0
- Test installation, upgrade and uninstall on a clean Windows machine.

Saved-session restoration and existing message decryption passed the local smoke check. The user also confirmed that a new encrypted group message sent after restart appeared in Element.

The installer is unsigned. Dependency maintenance advisories are recorded in VALIDATION.md. No independent security audit has been performed.

## License and sharing
Project code is GPL-3.0-only, with the full license in LICENSE. Dependencies retain their original licenses; their notices are in LICENSES and THIRD_PARTY_NOTICES.md. The installer also places these documents in its legal directory.

Share the complete Windows zip. It includes the installer, portable executable, matching source archive, build instructions and SHA-256 checksums. Keep the source and notices with the binaries when redistributing this package. The source includes pinned Rust dependencies and the frontend libraries' upstream source; development tools and WebView2 are installed separately. No account data is included.

## Using this candidate
Save drafts and close older copies first. Run the setup executable for a per-user installation, or use MatrixClient.exe if WebView2 is already installed. The installer downloads WebView2 if necessary. The existing app identifier is retained to preserve saved login compatibility.

Use browser sign-in for matrix.org. New accounts must configure recovery in Element first, then import the recovery key here. Join a space's child room before sending; private rooms may need separate invitations.

User data remains in the dev.matrixclient.prototype application-data directory. Never include that directory when sharing the app. Distribute only the generated archive.

Automated tests do not guarantee defect-free operation. See VALIDATION.md for results.

References:
- https://github.com/matrix-org/vodozemac/pull/448
- https://v2.tauri.app/distribute/windows-installer/
- https://v2.tauri.app/distribute/sign/windows/
