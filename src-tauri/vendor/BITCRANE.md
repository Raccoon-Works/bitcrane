# Patched crates

Unmodified copies of crates from crates.io, apart from the changes listed here.
They are wired in through `[patch.crates-io]` in `../Cargo.toml`. Drop a copy
again once the upstream release contains the change.

## smb 0.12.1 (MIT, https://github.com/afiffon/smb-rs)

- `Cargo.toml`: `sspi = "=0.21.3"` changed to `"=0.23.1"`. sspi 0.21.3 pins
  release candidates of curve25519-dalek, p256 and others, which cannot be
  resolved next to the final versions used by russh. The NTLM API used by smb
  is unchanged between the two sspi versions.
- `src/resource/file_util.rs`: the `use crate::sync_helpers::*;` import is gated
  on the `std-fs-impls` feature, the only code in the file that uses it.
  Without the gate Bitcrane's feature set (no `std-fs-impls`) makes Clippy warn
  about an unused import, and a path dependency's warnings are shown in our build.

## smb-transport 0.12.1 (MIT, https://github.com/afiffon/smb-rs)

- `src/tcp/transport.rs`: `set_nodelay(true)` on the TCP socket. Without it
  every SMB round trip waits for a delayed ACK (about 40 ms).
