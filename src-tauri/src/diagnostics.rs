use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

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

    if let Some(version) = installed_package_version(&path) {
        let compatible = is_compatible_version(&version);
        return PiEnvironmentReport {
            status: "ready".into(),
            path: Some(path),
            version: Some(version.to_string()),
            compatible,
            node_path,
            message: if compatible {
                "Pi is ready.".into()
            } else {
                "Pi Desktop requires Pi 0.80.x.".into()
            },
        };
    }

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

fn installed_package_version(executable: &Path) -> Option<Version> {
    let mut candidates = Vec::new();
    if let Some(parent) = executable.parent() {
        candidates.push(
            parent
                .join("node_modules")
                .join("@earendil-works")
                .join("pi-coding-agent")
                .join("package.json"),
        );
    }
    if let Ok(target) = fs::canonicalize(executable)
        && let Some(package_root) = target.parent().and_then(Path::parent)
    {
        candidates.push(package_root.join("package.json"));
    }

    candidates.into_iter().find_map(|candidate| {
        let bytes = fs::read(candidate).ok()?;
        let manifest = serde_json::from_slice::<serde_json::Value>(&bytes).ok()?;
        let name = manifest.get("name").and_then(serde_json::Value::as_str)?;
        if name != "@earendil-works/pi-coding-agent" {
            return None;
        }
        Version::parse(manifest.get("version")?.as_str()?).ok()
    })
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
    use std::fs;

    use semver::Version;

    use super::{installed_package_version, is_compatible_version};

    #[test]
    fn accepts_only_the_validated_pi_protocol_series() {
        assert!(is_compatible_version(&Version::parse("0.80.0").unwrap()));
        assert!(is_compatible_version(&Version::parse("0.80.10").unwrap()));
        assert!(!is_compatible_version(&Version::parse("0.79.9").unwrap()));
        assert!(!is_compatible_version(&Version::parse("0.81.0").unwrap()));
        assert!(!is_compatible_version(&Version::parse("1.0.0").unwrap()));
    }

    #[test]
    fn reads_the_standard_global_install_without_launching_pi() {
        let directory = tempfile::tempdir().unwrap();
        let executable = directory.path().join("pi.cmd");
        let package = directory
            .path()
            .join("node_modules/@earendil-works/pi-coding-agent/package.json");
        fs::create_dir_all(package.parent().unwrap()).unwrap();
        fs::write(&executable, "@echo off").unwrap();
        fs::write(
            package,
            r#"{"name":"@earendil-works/pi-coding-agent","version":"0.80.10"}"#,
        )
        .unwrap();

        assert_eq!(
            installed_package_version(&executable),
            Some(Version::parse("0.80.10").unwrap())
        );
    }
}
