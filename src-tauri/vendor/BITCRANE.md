# Patched crates

Copies of crates from crates.io, apart from the changes listed here. They are
wired in through `[patch.crates-io]` in `../Cargo.toml`. Drop a copy again once
the upstream release contains the change.

Both copies come from the smb-rs repository at commit
`7c7d4a60c930e3780e95208967aa13b6346eaa25` (as recorded by the crates.io
packages, `crates/smb` and `crates/smb-transport`).

## What was left out of the packages

Only files that the build does not read were removed, so the sources stay
identical to the release and can be compared with it line by line:

- `.cargo-ok`, `.cargo_vcs_info.json` (its commit is noted above),
  `Cargo.toml.orig` and `Cargo.lock`: packaging leftovers; Cargo ignores the lock
  file of a dependency.
- `smb/tests/` (integration tests against a Samba server in Docker, with its
  `Dockerfile`) and the `[[test]]` entries for them in `smb/Cargo.toml`;
  `smb-transport/scripts/` (configuration of such a test server).
- `smb-transport/README.rdma.md`: documentation of the RDMA transport.

Kept although Bitcrane does not use them: the QUIC and RDMA transports in
`smb-transport/src/` and everything else behind features Bitcrane does not
enable. They are not compiled, and removing them would mean editing the crates'
module and feature lists, which makes each copy harder to compare with upstream
and to update. `README.md`, `LICENSE.md` and `smb/docs/` stay as well; the docs
are part of the crate's documentation through `include_str!`.

## Recommendation

Vendored copies have to be compared and replaced by hand on every update. Better
ways, not done yet: send both fixes upstream (they are small and generally
useful), or keep them on a fork of smb-rs and point `[patch.crates-io]` at that
git repository and commit instead of these folders.

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
