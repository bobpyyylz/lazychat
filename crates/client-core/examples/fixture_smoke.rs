//! Exercises the real SDK against our synthetic loopback protocol fixture.
//! Run through `node scripts/test-messaging.mjs` after installing Rust.

use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail, ensure};
use client_core::{Core, Message};
use tokio::{
    task::JoinHandle,
    time::{sleep, timeout},
};

const ALICE_SECRET: &str = "fixture-only-alice-store-secret-32-characters";
const BOB_SECRET: &str = "fixture-only-bob-store-secret-32-characters";
const ENCRYPTED_ROOM: &str = "!encrypted:fixture.local";
const PLAIN_ROOM: &str = "!plain:fixture.local";
const ENCRYPTED_MARKER: &str = "Synthetic encrypted test message: pomegranate-48319";
const REPLY_MARKER: &str = "Synthetic encrypted reply: nectarine-93721";

fn main() -> Result<()> {
    // Match the desktop runtime's stack allocation, including the test's main
    // future, rather than Windows' small default main-thread stack.
    std::thread::Builder::new()
        .stack_size(8 * 1024 * 1024)
        .spawn(|| {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .thread_stack_size(8 * 1024 * 1024)
                .build()?
                .block_on(async {
                    timeout(Duration::from_secs(180), run())
                        .await
                        .context("Integration smoke test timed out.")??;
                    Ok(())
                })
        })?
        .join()
        .map_err(|_| anyhow::anyhow!("Fixture runtime thread panicked"))?
}

async fn run() -> Result<()> {
    let homeserver =
        std::env::var("MATRIX_FIXTURE_URL").unwrap_or_else(|_| "http://127.0.0.1:18848".into());
    let run_id = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis()
    );
    // Keep artifacts for inspecting encrypted records and debugging. They contain
    // synthetic accounts only and are ignored by git under target/.
    let storage = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/fixture-data")
        .join(run_id);
    std::fs::create_dir_all(&storage)?;
    let alice_path = storage.join("alice");
    let bob_path = storage.join("bob");
    println!("Signing in two synthetic fixture accounts.");
    let alice = Arc::new(
        Core::login_password(
            &homeserver,
            "@alice:fixture.local",
            "test-password",
            &alice_path,
            ALICE_SECRET,
        )
        .await?,
    );
    let bob = Arc::new(
        Core::login_password(
            &homeserver,
            "@bob:fixture.local",
            "test-password",
            &bob_path,
            BOB_SECRET,
        )
        .await?,
    );
    alice.sync_once().await?;
    bob.sync_once().await?;
    let alice_sync = sync_background(alice.clone());
    let bob_sync = sync_background(bob.clone());

    ensure!(
        alice
            .rooms()
            .await?
            .iter()
            .any(|r| r.id == ENCRYPTED_ROOM && r.joined && r.encrypted && r.encryption_known),
        "Encrypted room missing after sync."
    );
    ensure!(
        alice
            .rooms()
            .await?
            .iter()
            .any(|r| r.id == PLAIN_ROOM && !r.encrypted && r.encryption_known),
        "Plain room missing after sync."
    );
    ensure!(
        alice.join_room("#plain:fixture.local").await? == PLAIN_ROOM,
        "Joining alias resolved incorrectly."
    );
    ensure!(
        alice
            .rooms()
            .await?
            .iter()
            .any(|r| r.id == "!space:fixture.local" && r.is_space),
        "Space was not identified."
    );
    let space_error = alice
        .send_message(
            "!space:fixture.local",
            "Should not send",
            "fixture-space-send",
        )
        .await
        .err()
        .context("Space send should be blocked")?;
    ensure!(
        space_error.to_string().contains("This is a space"),
        "Space send needs an actionable error."
    );
    let children = alice.space_rooms("!space:fixture.local", None).await?;
    ensure!(
        children.rooms.len() == 2 && children.rooms.iter().any(|r| r.id == ENCRYPTED_ROOM),
        "Space child rooms are missing."
    );
    let denied = alice
        .send_message(PLAIN_ROOM, "Must fail", "fixture-forbidden")
        .await
        .err()
        .context("Forbidden send should fail")?;
    ensure!(
        denied.to_string().contains("M_FORBIDDEN")
            && denied
                .to_string()
                .contains("Fixture room permission denied"),
        "Server rejection was hidden."
    );

    let plain = alice
        .send_message(
            PLAIN_ROOM,
            "Synthetic plain fixture message",
            "fixture-plain-send",
        )
        .await?;
    let plain_retry = alice
        .send_message(
            PLAIN_ROOM,
            "Synthetic plain fixture message",
            "fixture-plain-send",
        )
        .await?;
    ensure!(
        plain == plain_retry,
        "Retry with the same transaction duplicated the event."
    );
    wait_for_message(
        &bob,
        PLAIN_ROOM,
        &plain,
        "Synthetic plain fixture message",
        false,
    )
    .await?;

    ensure!(
        !alice.security_status().await?.device_verified,
        "Fresh fixture device unexpectedly verified."
    );
    ensure!(
        alice
            .send_message(ENCRYPTED_ROOM, ENCRYPTED_MARKER, "fixture-blocked-send")
            .await
            .is_err(),
        "Unverified device was allowed to send encrypted content."
    );
    println!("Bootstrapping synthetic identities; production uses existing recovery secrets.");
    alice.initialize_test_identity().await?;
    bob.initialize_test_identity().await?;
    wait_for_verification(&alice).await?;
    wait_for_verification(&bob).await?;

    println!("Sending and decrypting messages with the SDK's Matrix encryption.");
    let sent = alice
        .send_message(ENCRYPTED_ROOM, ENCRYPTED_MARKER, "fixture-encrypted-send")
        .await?;
    let received = wait_for_message(&bob, ENCRYPTED_ROOM, &sent, ENCRYPTED_MARKER, true).await?;
    ensure!(
        received.sender == "@alice:fixture.local",
        "Unexpected encrypted sender."
    );
    let reply = bob
        .send_message(ENCRYPTED_ROOM, REPLY_MARKER, "fixture-encrypted-reply")
        .await?;
    wait_for_message(&alice, ENCRYPTED_ROOM, &reply, REPLY_MARKER, true).await?;

    println!("Reopening the same device and checking stored encryption keys.");
    let session = alice.export_session()?;
    let original_account = alice.account();
    stop_sync(alice_sync).await;
    drop(alice);
    // Give SDK background workers a chance to release their database handles.
    sleep(Duration::from_millis(200)).await;
    ensure!(
        Core::restore(
            &session,
            &alice_path,
            "incorrect-fixture-secret-at-least-32-chars"
        )
        .await
        .is_err(),
        "The protected store accepted an incorrect secret."
    );
    let restored = Arc::new(Core::restore(&session, &alice_path, ALICE_SECRET).await?);
    ensure!(
        restored.account().device_id == original_account.device_id,
        "Restore created a different device."
    );
    ensure!(
        restored.account().user_id == original_account.user_id,
        "Restore changed the account."
    );
    restored.sync_once().await?;
    let restored_sync = sync_background(restored.clone());
    wait_for_message(&restored, ENCRYPTED_ROOM, &reply, REPLY_MARKER, true).await?;
    let after_restart = restored
        .send_message(
            ENCRYPTED_ROOM,
            "Synthetic message after store reopen",
            "fixture-after-restore",
        )
        .await?;
    wait_for_message(
        &bob,
        ENCRYPTED_ROOM,
        &after_restart,
        "Synthetic message after store reopen",
        true,
    )
    .await?;

    stop_sync(restored_sync).await;
    stop_sync(bob_sync).await;
    restored.logout().await?;
    // A server-revoked token must not trap the user in a saved login.
    restored.logout().await?;
    bob.logout().await?;
    println!(
        "{}",
        serde_json::json!({
            "passed": true,
            "checks": ["space_classification", "space_send_blocked", "space_children", "server_rejection_visible", "password_login", "classic_sync", "room_list", "join_alias", "plain_send_receive", "transaction_retry", "unverified_send_blocked", "encrypted_send_receive", "encrypted_reply", "wrong_store_secret_rejected", "same_device_restore", "historical_decryption_after_restore", "encrypted_send_after_restore", "logout"],
            "storeArtifacts": storage,
        })
    );
    Ok(())
}

fn sync_background(core: Arc<Core>) -> JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            if let Err(error) = core.sync_once().await {
                eprintln!("Fixture sync failed: {error:#}");
            }
            sleep(Duration::from_millis(100)).await;
        }
    })
}

async fn stop_sync(task: JoinHandle<()>) {
    task.abort();
    let _ = task.await;
}

async fn wait_for_verification(core: &Core) -> Result<()> {
    for _ in 0..80 {
        if core.security_status().await?.device_verified {
            return Ok(());
        }
        sleep(Duration::from_millis(250)).await;
    }
    bail!("Fixture cross-signing did not verify this device.")
}

async fn wait_for_message(
    core: &Core,
    room: &str,
    event: &str,
    body: &str,
    encrypted: bool,
) -> Result<Message> {
    for _ in 0..80 {
        let messages = core.messages(room, 100).await?;
        if let Some(message) = messages
            .into_iter()
            .find(|m| m.id == event && !m.unable_to_decrypt)
        {
            ensure!(
                message.body == body,
                "Received message body differs from sent text."
            );
            ensure!(
                message.encrypted == encrypted,
                "Message encryption label does not match transport."
            );
            return Ok(message);
        }
        sleep(Duration::from_millis(250)).await;
    }
    bail!("Expected message did not become readable within 20 seconds.")
}
