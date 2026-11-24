use std::io::{Read, Seek, SeekFrom};

pub(super) fn verify(file: &mut (impl Read + Seek), target: &str) -> Result<(), String> {
    let mut header = [0u8; 64];
    file.read_exact(&mut header)
        .map_err(|error| error.to_string())?;
    let matches = match target {
        "aarch64-apple-darwin" => {
            header.starts_with(&[0xcf, 0xfa, 0xed, 0xfe])
                && header[4..8] == 0x0100000cu32.to_le_bytes()
                && header[12..16] == 2u32.to_le_bytes()
        }
        "aarch64-unknown-linux-gnu" => elf(&header, 183),
        "x86_64-unknown-linux-gnu" => elf(&header, 62),
        "aarch64-pc-windows-msvc" => pe(file, &header, 0xaa64)?,
        "x86_64-pc-windows-msvc" => pe(file, &header, 0x8664)?,
        _ => false,
    };
    if !matches {
        return Err(format!(
            "The Bamboo executable's native header does not match {target}"
        ));
    }
    Ok(())
}

fn elf(header: &[u8; 64], machine: u16) -> bool {
    header.starts_with(b"\x7fELF\x02\x01\x01")
        && matches!(u16::from_le_bytes([header[16], header[17]]), 2 | 3)
        && header[18..20] == machine.to_le_bytes()
}

fn pe(file: &mut (impl Read + Seek), header: &[u8; 64], machine: u16) -> Result<bool, String> {
    if !header.starts_with(b"MZ") {
        return Ok(false);
    }
    let offset = u32::from_le_bytes(header[60..64].try_into().expect("PE header offset field"));
    if offset < header.len() as u32 {
        return Ok(false);
    }
    file.seek(SeekFrom::Start(u64::from(offset)))
        .map_err(|error| error.to_string())?;
    let mut pe_header = [0u8; 26];
    file.read_exact(&mut pe_header)
        .map_err(|error| error.to_string())?;
    Ok(pe_header.starts_with(b"PE\0\0")
        && pe_header[4..6] == machine.to_le_bytes()
        && pe_header[24..26] == 0x020bu16.to_le_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::component_channel::NATIVE_TARGETS;
    use std::io::Cursor;

    fn fixture(target: &str) -> [u8; 128] {
        let mut header = [0u8; 128];
        if target.ends_with("-windows-msvc") {
            let machine: u16 = if target.starts_with("aarch64-") {
                0xaa64
            } else {
                0x8664
            };
            header[..2].copy_from_slice(b"MZ");
            header[60..64].copy_from_slice(&64u32.to_le_bytes());
            header[64..68].copy_from_slice(b"PE\0\0");
            header[68..70].copy_from_slice(&machine.to_le_bytes());
            header[88..90].copy_from_slice(&0x020bu16.to_le_bytes());
        } else if target.ends_with("-linux-gnu") {
            let machine: u16 = if target.starts_with("aarch64-") {
                183
            } else {
                62
            };
            header[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
            header[16..18].copy_from_slice(&3u16.to_le_bytes());
            header[18..20].copy_from_slice(&machine.to_le_bytes());
        } else {
            header[..4].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe]);
            header[4..8].copy_from_slice(&0x0100000cu32.to_le_bytes());
            header[12..16].copy_from_slice(&2u32.to_le_bytes());
        }
        header
    }

    #[test]
    fn only_the_exact_os_and_cpu_pair_matches() {
        for source in NATIVE_TARGETS {
            for destination in NATIVE_TARGETS {
                let result = verify(&mut Cursor::new(fixture(source)), destination);
                assert_eq!(result.is_ok(), source == destination);
            }
        }
    }
}
