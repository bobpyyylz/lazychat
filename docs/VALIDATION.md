# Release candidate validation — November 7, 2026

This report covers the Windows messaging implementation, not the broader planned feature set.

## Review coverage

Reviewed the Rust SDK wrapper, Tauri IPC commands, session storage, React account/room lifecycle, space navigation, retry handling, build scripts and distribution configuration. Formatting was normalized with rustfmt and Prettier. This was a code review and regression-testing pass, not an independent security audit.

## Checks

- Seven Rust unit tests passed, including DPAPI round-trip/tamper detection and path validation.
- Four React regression tests passed: joining/opening a space child, unmount during join, stale hierarchy responses, and keeping the draft/transaction ID after a failed sign-out.
- TypeScript check and production frontend build passed.
- Rust Clippy and the optimized Windows x64 release build passed. NSIS produced the installer with the GPL license screen and bundled legal documents.
- The two fixture protocol tests passed. The SDK harness passed all 18 named scenarios on the final run.
- The real Matrix SDK integration harness passed text/encrypted exchange, key persistence and restore, invalid store-key rejection, transaction deduplication, space handling, visible server rejection and repeated sign-out after token revocation.
- npm audit reported no known vulnerabilities at review time.
- cargo audit initially flagged vodozemac 0.11.1. The lockfile now uses patched 0.11.2; the repeated vulnerability scan returned zero findings. Informational warnings remain for anymap2, derivative, proc-macro-error, zbus_names, zvariant and zvariant_derive. The glib unsoundness advisory concerns a dependency absent from the Windows target tree; it must be revisited before a Linux release.
- The packaged portable executable opened on this Windows machine, restored the existing account with its device verified, and decrypted existing direct and group messages. Space navigation listed and opened the joined child room. No real-account messages were sent by the automated smoke check.
- After that restart, the user manually sent a message in the encrypted test room and confirmed that it appeared in Element. This completes the live group-message acceptance check for this candidate.
- The release zip passed its integrity check. Its matching source archive contains all 34,660 vendored dependency files with the hashes recorded by Cargo. Account stores, node_modules, target directories and local tool caches are excluded. Dependency notice collection reported no packages missing a license/notice file.
- Cargo resolved the extracted source archive's full dependency graph offline with the pinned lockfile. A complete rebuild on another machine has not been performed.

## Not established by these checks

Fresh-machine installer/upgrade/uninstall behavior, all supported homeservers, complete Matrix interoperability, adversarial security properties, recovery with every account configuration, or long-duration reliability. Existing screenshots demonstrate real-account sign-in, recovery status and encrypted direct messaging in earlier builds; they are not a complete acceptance test for this candidate.

Before stable release, test installation, upgrade and uninstall on a clean Windows machine. An existing installation was detected here, so the temporary installer test stopped before changing it. The generated archive is an unsigned release candidate for testing.
