//! One running editor per profile directory on platforms without the Linux
//! profile-owner socket (`instance.rs`). The lock is advisory, tied to the
//! open file, and released by the system when the process ends, so a crash
//! cannot leave a stale lock behind.
use std::fs::{File, OpenOptions};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::io::AsRawFd;
use std::path::Path;

/// Holds the profile for as long as it lives.
#[derive(Debug)]
pub struct ProfileLock(#[allow(dead_code)] File);

/// `Ok(None)` means another process already holds this profile.
pub fn acquire(directory: &Path) -> Result<Option<ProfileLock>, String> {
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create the local data directory: {error}"))?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        // Never lock through a planted symbolic link.
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(directory.join("instance.lock"))
        .map_err(|error| format!("Could not open the profile lock: {error}"))?;
    loop {
        // SAFETY: the descriptor belongs to `file`, which outlives the call.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(Some(ProfileLock(file)));
        }
        let error = std::io::Error::last_os_error();
        match error.kind() {
            std::io::ErrorKind::WouldBlock => return Ok(None),
            std::io::ErrorKind::Interrupted => continue,
            _ => return Err(format!("Could not lock the profile: {error}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_profile_has_one_holder_until_it_is_released() {
        let directory = tempfile::tempdir().unwrap();
        let profile = directory.path().join("nested/profile");
        let first = acquire(&profile).unwrap().expect("first holder");
        assert!(acquire(&profile).unwrap().is_none());
        assert!(acquire(&profile).unwrap().is_none());
        // Another profile is independent.
        let other = acquire(&directory.path().join("other")).unwrap();
        assert!(other.is_some());
        drop(first);
        let second = acquire(&profile).unwrap();
        assert!(second.is_some());
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(profile.join("instance.lock")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn a_symbolic_link_in_place_of_the_lock_is_refused() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("elsewhere");
        std::fs::write(&target, "").unwrap();
        std::os::unix::fs::symlink(&target, directory.path().join("instance.lock")).unwrap();
        assert!(acquire(directory.path()).is_err());
    }
}
