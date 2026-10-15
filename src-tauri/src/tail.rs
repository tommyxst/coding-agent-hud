use std::{
    fs::File,
    io::{BufRead, BufReader, Seek, SeekFrom},
    os::windows::io::AsRawHandle,
    path::Path,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
};

/// Offset commits only complete records. Partial UTF-8 is left on disk until newline.
#[derive(Default)]
pub struct JsonlTail {
    pub offset: u64,
    identity: Option<(u32, u32, u32)>,
}

impl JsonlTail {
    fn prepare(&mut self, file: &File) -> Result<bool, String> {
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
            return Err(format!(
                "identify telemetry file: {}",
                std::io::Error::last_os_error()
            ));
        }
        let identity = (
            info.dwVolumeSerialNumber,
            info.nFileIndexHigh,
            info.nFileIndexLow,
        );
        let length = file
            .metadata()
            .map_err(|e| format!("stat telemetry file: {e}"))?
            .len();
        let reset =
            self.identity.is_some_and(|previous| previous != identity) || length < self.offset;
        if reset {
            self.offset = 0;
        }
        self.identity = Some(identity);
        Ok(reset)
    }

    pub fn reset_if_changed(&mut self, path: &Path) -> Result<bool, String> {
        let file = File::open(path).map_err(|e| format!("open telemetry file: {e}"))?;
        self.prepare(&file)
    }

    pub fn read(
        &mut self,
        path: &Path,
        mut consume: impl FnMut(&[u8]) -> Result<(), String>,
    ) -> Result<bool, String> {
        let file = File::open(path).map_err(|e| format!("open telemetry file: {e}"))?;
        let truncated = self.prepare(&file)?;
        let mut reader = BufReader::new(file);
        reader
            .seek(SeekFrom::Start(self.offset))
            .map_err(|e| format!("seek rollout: {e}"))?;
        let mut line = Vec::new();
        loop {
            line.clear();
            let count = reader
                .read_until(b'\n', &mut line)
                .map_err(|e| format!("read rollout: {e}"))?;
            if count == 0 || line.last() != Some(&b'\n') {
                break;
            }
            consume(&line)?;
            self.offset += count as u64;
        }
        Ok(truncated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Write};
    fn file(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("hud-tail-{}-{name}", std::process::id()))
    }
    #[test]
    fn partial_lines_and_duplicates() {
        let path = file("partial");
        fs::write(&path, b"{\"id\":1}\n{\"id\":").unwrap();
        let mut tail = JsonlTail::default();
        let mut lines = Vec::new();
        tail.read(&path, |line| {
            lines.push(line.to_vec());
            Ok(())
        })
        .unwrap();
        assert_eq!(lines.len(), 1);
        tail.read(&path, |line| {
            lines.push(line.to_vec());
            Ok(())
        })
        .unwrap();
        assert_eq!(lines.len(), 1);
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"2}\n")
            .unwrap();
        tail.read(&path, |line| {
            lines.push(line.to_vec());
            Ok(())
        })
        .unwrap();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[1], b"{\"id\":2}\n");
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn truncation_restarts_and_parse_error_preserves_offset() {
        let path = file("truncate");
        fs::write(&path, b"first record\n").unwrap();
        let mut tail = JsonlTail::default();
        tail.read(&path, |_| Ok(())).unwrap();
        fs::write(&path, b"new\n").unwrap();
        assert!(tail.read(&path, |_| Ok(())).unwrap());
        fs::write(&path, b"new\nbad\n").unwrap();
        assert!(tail.read(&path, |_| Err("parse error".into())).is_err());
        assert_eq!(tail.offset, 4);
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn utf8_split_does_not_parse_incomplete_bytes() {
        let path = file("utf8");
        fs::write(&path, [0xe4, 0xb8]).unwrap();
        let mut tail = JsonlTail::default();
        tail.read(&path, |_| panic!("partial line consumed"))
            .unwrap();
        assert_eq!(tail.offset, 0);
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(&[0xad, b'\n'])
            .unwrap();
        tail.read(&path, |line| {
            assert_eq!(std::str::from_utf8(line).unwrap(), "中\n");
            Ok(())
        })
        .unwrap();
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn same_length_replacement_restarts_by_file_identity() {
        let path = file("replacement");
        let old = file("replacement-old");
        fs::write(&path, b"old\n").unwrap();
        let mut tail = JsonlTail::default();
        tail.read(&path, |_| Ok(())).unwrap();
        fs::rename(&path, &old).unwrap();
        fs::write(&path, b"new\n").unwrap();
        let mut records = Vec::new();
        assert!(tail
            .read(&path, |line| {
                records.push(line.to_vec());
                Ok(())
            })
            .unwrap());
        assert_eq!(records, vec![b"new\n".to_vec()]);
        fs::remove_file(path).unwrap();
        fs::remove_file(old).unwrap();
    }
}
