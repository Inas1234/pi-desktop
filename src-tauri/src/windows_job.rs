#[cfg(windows)]
mod platform {
    use std::{ffi::c_void, io, mem};

    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::{
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
                SetInformationJobObject,
            },
            Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE},
        },
    };

    pub struct JobGuard(HANDLE);

    unsafe impl Send for JobGuard {}
    unsafe impl Sync for JobGuard {}

    impl JobGuard {
        pub fn attach(process_id: u32) -> io::Result<Self> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return Err(io::Error::last_os_error());
                }

                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let configured = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    mem::size_of_val(&info) as u32,
                );
                if configured == 0 {
                    CloseHandle(job);
                    return Err(io::Error::last_os_error());
                }

                let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, process_id);
                if process.is_null() {
                    CloseHandle(job);
                    return Err(io::Error::last_os_error());
                }
                let assigned = AssignProcessToJobObject(job, process);
                CloseHandle(process);
                if assigned == 0 {
                    CloseHandle(job);
                    return Err(io::Error::last_os_error());
                }

                Ok(Self(job))
            }
        }
    }

    impl Drop for JobGuard {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use std::io;

    pub struct JobGuard;

    impl JobGuard {
        pub fn attach(_process_id: u32) -> io::Result<Self> {
            Ok(Self)
        }
    }
}

pub use platform::JobGuard;
