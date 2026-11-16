# ITVR RDP

RDP and SSH connection manager for Windows and macOS, modelled on Remote Desktop Manager.

## Run
- `npm install --registry=https://registry.npmjs.org/`
- `npm start` builds and runs; `npm run dev` for hot reload
- `npm test` runs the unit suites (NTLM, RD Gateway protocol, store, RDM import, SFTP)
- `npm run smoke` runs an end-to-end UI smoke test against a throwaway profile
- `npm run dist:win` for the Windows installer, portable `.exe` and ZIP
- `npm run dist:mac-from-win` builds unsigned macOS zips (arm64 + x64) on Windows
  (`scripts/build-mac.js`; `npm run dist:mac` on a Mac gives a proper `.dmg`)

If the Electron binary is missing behind the corporate proxy, set `NODE_USE_ENV_PROXY=1`
and `HTTPS_PROXY`, then run `node node_modules/electron/install.js`.

## Features
- **Embedded RDP tabs**: IronRDP (WebAssembly) renders into a canvas. A local proxy
  (127.0.0.1, random port, one-time tickets) does TCP + TLS to the server. NLA/CredSSP works.
  Server certificates are pinned on first use.
- **RD Gateway**: set a gateway host on an RDP entry. Embedded sessions tunnel through it using the
  HTTPS WebSocket transport with NTLM sign-in (Windows Server 2016+). The gateway can use the same
  login as the server or its own shared credential. Not supported: legacy two-channel HTTP,
  RPC-over-HTTP, Kerberos-only, smart-card and Entra ID gateway sign-in.
- **External RDP** (per entry or right-click): `mstsc` on Windows, Microsoft Remote Desktop on macOS.
- **SSH**: embedded terminal tabs (ssh2 + xterm.js), password or key auth, host keys pinned on first use.
- **SFTP file browser**: "Files (SFTP)" in any SSH tab. Browse, upload files/folders (button or
  drag-and-drop), download, new folder, rename, delete. Uses the existing SSH connection.
- **Shared credentials**: save a login once (Credentials button) and link it from any entry, or use a
  separate one for the gateway. Changing it updates every entry that uses it.
- **Import from RDM**: Import RDM accepts RDM XML (.rdm/.xml), JSON or CSV exports. Folders, RDP/SSH
  entries, gateway host and linked credentials are imported into a dated folder. Passwords are not
  imported (RDM encrypts them with its own keys); set them once on the shared credentials.
- **Storage**: entries and credentials live in the user data folder; passwords are encrypted with
  the OS keystore (DPAPI / Keychain). Exports never contain secrets.

## Third-party
- `vendor/ironrdp`: WebAssembly build of [IronRDP](https://github.com/Devolutions/IronRDP) (MIT/Apache-2.0)
  from [openif/irdp](https://github.com/openif/irdp) (MIT, see `vendor/ironrdp/LICENSE-irdp`).
  `electron/rdpProxy.js` and `src/rdp/scancodes.js` are adapted from openif/irdp.
- `electron/gateway.js` follows [MS-TSGU] and the FreeRDP (Apache-2.0) gateway implementation.
# ITVR-RDP
