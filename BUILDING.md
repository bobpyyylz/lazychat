# Windows build

Requirements: Windows x64, Node.js 24 with npm, Python 3.11 or later, Rust 1.99.1, Visual Studio 2022 C++ tools, Windows SDK 10.0.22621.0, and WebView2 to run the app.

1. Extract the matching source archive, including vendor and .cargo/config.toml.
2. Run `npm.cmd --prefix apps/client ci`.
3. Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows.ps1 release`.

The build produces an optimized executable and NSIS installer, packaged together with matching source in artifacts. Tauri downloads installer tools if missing. The installer downloads WebView2 if required. Initial npm and tool setup needs internet access; Rust dependency source is included in vendor. The third-party-sources directory includes the upstream React (including React DOM and scheduler) and Tauri API source archives used by the frontend. Third-party packages retain their original licenses.

When building from a repository checkout instead of the complete source archive, install the prerequisites, run `npm.cmd --prefix apps/client ci`, then run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prepare-source.ps1` before the release command above. This obtains dependency source for the release archive. Supplemental dependency notices are included in third-party-notices in both the repository and source archive.

The developer's .tools directory is excluded. Install Rust with rustup if needed; scripts fall back to the installed toolchain. CARGO_TARGET_DIR can override the output directory.

Checks:

```powershell
. .\scripts\build-env.ps1
npm.cmd --prefix apps/client test
npm.cmd --prefix apps/client run build
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
node --test tests/matrix-fixture/server.test.mjs
node scripts/test-messaging.mjs
```

The desktop build rejects the test-fixture feature. Its HTTP support and identity bootstrap are for synthetic local tests only.

The executable is unsigned. No signing keys are needed to rebuild it. Passwords, access tokens and recovery keys must not be included in source or release archives.
