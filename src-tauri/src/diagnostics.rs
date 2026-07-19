use std::{path::PathBuf, process::Command};

use semver::Version;

use crate::models::PiEnvironmentReport;

pub fn resolve_pi(override_path: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(path) = override_path.filter(|path| path.is_file()) {
        return Some(path);
    }

    #[cfg(windows)]
    if let Ok(path) = which::which("pi.cmd") {
        return Some(path);
    }

    which::which("pi").ok()
}

pub fn diagnose(override_path: Option<PathBuf>) -> PiEnvironmentReport {
    let node_path = which::which("node").ok();
    let Some(path) = resolve_pi(override_path) else {
        return PiEnvironmentReport {
            status: "missing".into(),
            path: None,
            version: None,
            compatible: false,
            node_path,
            message: "Pi was not found. Install @earendil-works/pi-coding-agent or choose its executable in Settings.".into(),
        };
    };

    let output = command_for(&path).arg("--version").output();
    let Ok(output) = output else {
        return PiEnvironmentReport {
            status: "unavailable".into(),
            path: Some(path),
            version: None,
            compatible: false,
            node_path,
            message: "Pi was found but could not be started.".into(),
        };
    };

    let raw = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let version_text = raw
        .split_whitespace()
        .find(|part| {
            part.chars()
                .next()
                .is_some_and(|char| char.is_ascii_digit())
        })
        .unwrap_or(raw.as_str())
        .trim_start_matches('v');
    let parsed = Version::parse(version_text).ok();
    let compatible = output.status.success() && parsed.as_ref().is_some_and(is_compatible_version);

    PiEnvironmentReport {
        status: if output.status.success() {
            "ready"
        } else {
            "unavailable"
        }
        .into(),
        path: Some(path),
        version: (!raw.is_empty()).then_some(raw),
        compatible,
        node_path,
        message: if !output.status.success() {
            "Pi was found, but its version check failed.".into()
        } else if compatible {
            "Pi is ready.".into()
        } else {
            "Pi Desktop 0.1 requires Pi 0.80.x.".into()
        },
    }
}

fn is_compatible_version(version: &Version) -> bool {
    version.major == 0 && version.minor == 80
}

pub fn command_for(path: &PathBuf) -> Command {
    let mut command = Command::new(path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

#[cfg(test)]
mod tests {
    use semver::Version;

    use super::is_compatible_version;

    #[test]
    fn accepts_only_the_validated_pi_protocol_series() {
        assert!(is_compatible_version(&Version::parse("0.80.0").unwrap()));
        assert!(is_compatible_version(&Version::parse("0.80.10").unwrap()));
        assert!(!is_compatible_version(&Version::parse("0.79.9").unwrap()));
        assert!(!is_compatible_version(&Version::parse("0.81.0").unwrap()));
        assert!(!is_compatible_version(&Version::parse("1.0.0").unwrap()));
    }
}
