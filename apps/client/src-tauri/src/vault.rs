//! Windows user-bound protection for the SDK store key and login session.
//! This is not an independent password vault or protection from same-user malware.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

#[derive(Serialize, Deserialize)]
pub struct SavedSession {
    pub version: u32,
    pub profile_id: String,
    pub store_secret: String,
    pub session: String,
}

impl SavedSession {
    pub fn store_path(&self, root: &Path) -> Result<PathBuf, String> {
        if self.version != 1 || uuid::Uuid::parse_str(&self.profile_id).is_err() {
            return Err("The saved session format is invalid or unsupported.".into());
        }
        Ok(root.join("profiles").join(&self.profile_id))
    }
}

impl Drop for SavedSession {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.store_secret.zeroize();
        self.session.zeroize();
    }
}

pub fn new_secret() -> Result<String, String> {
    let mut bytes = Zeroizing::new([0_u8; 32]);
    getrandom::fill(bytes.as_mut()).map_err(|_| "Could not generate a secure storage key.")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

pub fn save(root: &Path, session: &SavedSession) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|e| format!("Cannot create app data directory: {e}"))?;
    let plaintext =
        Zeroizing::new(serde_json::to_vec(session).map_err(|_| "Cannot encode the session.")?);
    let protected = protect(&plaintext)?;
    let temporary = root.join("session.pending");
    std::fs::write(&temporary, protected)
        .map_err(|e| format!("Cannot save protected session: {e}"))?;
    std::fs::rename(temporary, root.join("session.bin"))
        .map_err(|e| format!("Cannot finalize protected session: {e}"))
}

pub fn load(root: &Path) -> Result<Option<SavedSession>, String> {
    let path = root.join("session.bin");
    let protected = match std::fs::read(&path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot read saved session: {error}")),
    };
    if protected.len() > 1024 * 1024 {
        return Err("Saved session is unexpectedly large.".into());
    }
    let plaintext = Zeroizing::new(unprotect(&protected)?);
    let session: SavedSession =
        serde_json::from_slice(&plaintext).map_err(|_| "Saved session data is invalid.")?;
    session.store_path(root)?;
    Ok(Some(session))
}

pub fn forget(root: &Path) -> Result<(), String> {
    match std::fs::remove_file(root.join("session.bin")) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Cannot remove saved login: {e}")),
    }
}

#[cfg(windows)]
fn transform(input: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
        },
    };
    let data = CRYPT_INTEGER_BLOB {
        cbData: input.len().try_into().map_err(|_| "Session too large")?,
        pbData: input.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // DPAPI allocates output; LocalFree must release it. No machine-wide flag:
    // decryption stays bound to the current Windows user's credentials.
    let ok = unsafe {
        if encrypt {
            CryptProtectData(
                &data,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &data,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err("Windows could not unlock/protect the saved session for this user.".into());
    }
    let result =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        if !encrypt {
            use zeroize::Zeroize;
            std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize).zeroize();
        }
        LocalFree(output.pbData as *mut _);
    }
    Ok(result)
}

#[cfg(windows)]
fn protect(value: &[u8]) -> Result<Vec<u8>, String> {
    transform(value, true)
}
#[cfg(windows)]
fn unprotect(value: &[u8]) -> Result<Vec<u8>, String> {
    transform(value, false)
}
#[cfg(not(windows))]
fn protect(_: &[u8]) -> Result<Vec<u8>, String> {
    Err("Persistent login currently requires Windows. Other platform vaults are not implemented yet.".into())
}
#[cfg(not(windows))]
fn unprotect(_: &[u8]) -> Result<Vec<u8>, String> {
    Err("This saved login requires Windows.".into())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn dpapi_roundtrip_and_tamper_detection() {
        let message = b"synthetic-access-token-not-a-real-credential";
        let mut ciphertext = protect(message).unwrap();
        assert!(
            !ciphertext
                .windows(message.len())
                .any(|window| window == message)
        );
        assert_eq!(unprotect(&ciphertext).unwrap(), message);
        let last = ciphertext.len() - 1;
        ciphertext[last] ^= 1;
        assert!(unprotect(&ciphertext).is_err());
    }
    #[test]
    fn refuses_saved_paths_outside_profiles() {
        let saved = SavedSession {
            version: 1,
            profile_id: "../../elsewhere".into(),
            store_secret: String::new(),
            session: String::new(),
        };
        assert!(saved.store_path(Path::new("example")).is_err());
    }
}
