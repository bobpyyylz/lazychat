//! Checks real matrix.org discovery and SDK SSO setup without authenticating,
//! opening a browser, creating an account/device, or sending messages.
use anyhow::{Result, ensure};
use client_core::Core;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

fn main() -> Result<()> {
    std::thread::Builder::new()
        .stack_size(8 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .thread_stack_size(8 * 1024 * 1024)
                .build()?
                .block_on(probe())
        })?
        .join()
        .map_err(|_| anyhow::anyhow!("Probe thread panicked"))?
}

async fn probe() -> Result<()> {
    let reached = Arc::new(AtomicBool::new(false));
    let signal = reached.clone();
    let store = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/sign-in-probe")
        .join(std::process::id().to_string());
    let result = Core::login_sso(
        "https://matrix.org",
        &store,
        "public-probe-only-store-secret-no-user-credentials",
        move |address| {
            let url = url::Url::parse(&address).map_err(|e| e.to_string())?;
            if url.scheme() != "https" || url.host_str() != Some("matrix-client.matrix.org") {
                return Err("Unexpected SSO destination".into());
            }
            signal.store(true, Ordering::SeqCst);
            println!(
                "matrix.org discovery, TLS, login capabilities, and SDK SSO callback setup passed."
            );
            // Deliberately stop before opening the browser or authentication.
            Err("Probe complete; no account sign-in attempted".into())
        },
    )
    .await;
    ensure!(
        reached.load(Ordering::SeqCst),
        "SSO setup failed before the browser callback: {}",
        result.err().map(|e| format!("{e:#}")).unwrap_or_default()
    );
    Ok(())
}
