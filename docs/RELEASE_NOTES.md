## Matrix Client 1.0.0-rc.1

Windows x64 release candidate for text messaging over Matrix.

### Included
- Browser sign-in, saved sessions and existing-key recovery.
- Direct messages, encrypted rooms and space navigation.
- Preserved drafts and transaction IDs when a send fails.
- GPL-3.0-only project license, dependency notices and matching source.

### Validation
Automated tests passed. Saved-session restoration and message decryption were checked, and a new encrypted group message was manually confirmed in Element after restarting the app.

### Before you install
This is an unsigned pre-release. Installation, upgrade and uninstall still need testing on a clean Windows machine. Attachments, calls, notifications, CSS theme loading, Linux and Android are not included.

Download the attached Windows ZIP and extract it. Use the setup executable, or run MatrixClient.exe if WebView2 is installed. Keep the complete package, including source and license files, when sharing it.
