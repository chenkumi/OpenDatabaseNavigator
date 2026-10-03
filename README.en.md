# Database Workspace

[繁體中文](README.md) · **English**

A desktop database client for humans and AI agents. An Electron app to browse, query and edit several databases, with a built-in local [MCP](https://modelcontextprotocol.io/) server so AI agents share your workspace through tools that are **gated by permissions and approvals**.

![Database Workspace](docs/images/workspace.png)

> The user interface and most of the documentation are in Traditional Chinese (the UI also ships in English). The sections below are a translated overview.

## Features

- **Databases**: SQLite, PostgreSQL, MySQL/MariaDB, SQL Server (SQL login, plus Windows authentication on Windows) and Redis. SAP/Sybase ASE is experimental and has not been verified against a real ASE server.
- **Queries and data**: Monaco SQL editor with table/column completion, virtualized result grid, inline editing, up to 30 AND filters, CSV/JSON export, SQL file execution, SQL dump export.
- **Schema design**: table/view designer, indexes, triggers, foreign keys and CHECK constraints, generated columns. Create, rename and drop show a SQL preview first and check the object version.
- **Redis**: browse and edit strings, hashes, lists, sets, sorted sets, streams and JSON, keeping TTLs.
- **Shared agent workspace**: tabs and results opened by an agent appear in your workspace; writes need approval from the desktop user and every action is audited.
- **UI**: Traditional Chinese / English, dark / light, resizable three-pane layout.

| Schema designer                                        | Agent / MCP shared workspace                  |
| ------------------------------------------------------ | --------------------------------------------- |
| ![Schema designer](docs/images/structure-designer.png) | ![Agent workspace](docs/images/agent-mcp.png) |

## Getting started

Requires **Node.js 24+** and npm for development/builds. On Linux, install the Electron system libraries and provide a desktop display; see the [platform prerequisites](README.md#平台編譯與前置套件). WSL requires WSLg or another working display service. The display alone does not provide secure password storage.

```sh
npm ci             # install from package-lock.json
node node_modules/electron/install.js  # ensure the Electron binary is downloaded
npm run dev        # start development mode
```

```sh
npm run build      # type-check and build; needed initially / after source changes
npm start          # run the build, without extra flags
npm run package    # build an unpacked app for the current platform (release/)
npm run test:packaged  # packaged desktop / SQLite smoke
```

SQL Server Windows authentication is available only on Windows and requires Microsoft ODBC Driver 18. ASE is experimental and needs separately obtained SAP drivers/tools; it is not generally Windows-only. Native optional drivers must match the target OS and architecture.

### Linux / WSL secure storage and startup

**One-time Ubuntu 24.04 setup**, if a Secret Service provider is not already installed (other distributions use equivalent packages):

```sh
sudo apt-get update
sudo apt-get install gnome-keyring libsecret-1-0 libsecret-tools seahorse
```

**Each session:** ensure the app and keyring can reach the same user's desktop D-Bus session, and that the keyring is unlocked. WSL restart/login may require unlocking again; skip these steps if your desktop already starts and unlocks the service:

```sh
gnome-keyring-daemon --start --components=secrets
seahorse
busctl --user list | grep org.freedesktop.secrets
npm run check:secure-storage
```

In Seahorse, create/unlock the default password keyring with a **nonempty master password**. A D-Bus service name or installed packages alone do not prove encryption works. The check uses real Electron, an isolated profile and nonsecret test data; it exits **0** only when a secure backend is available and encryption/decryption succeeds (`available: true`, `roundtrip: true`). It does not read existing passwords.

Normal startup is plain `npm start`, `npm run dev`, or direct execution:

```sh
./release/linux-unpacked/database-workspace
"./release/Database Workspace-0.1.0.AppImage"
```

On WSL without a recognized native desktop or an explicit backend selection, the app now selects libsecret before Electron is ready. In the current WSL x64 acceptance, plain startup selected `gnome_libsecret` with source `wsl-libsecret`. Recognized GNOME/KDE desktops, other Linux environments, Windows/macOS and explicit selections retain their own strategy; do not spoof `XDG_CURRENT_DESKTOP`.

Settings and connection forms show secure storage availability, backend, selection source and **Recheck secure storage**. Installation commands are display-only guidance for manual execution; the app does not run them. Unlock the keyring, then recheck; restart and recheck if still unavailable or instructed. Backend failure refuses new/replacement passwords and preserves existing encrypted credentials, but **does not block SQLite or passwordless connections**. Status cannot distinguish a missing, locked or unreachable keyring.

Explicit libsecret is **troubleshooting only**, not routine startup:

```sh
npm run check:secure-storage -- --password-store=gnome-libsecret
# Only after confirming the same backend is needed for troubleshooting:
npm start -- --password-store=gnome-libsecret
```

Do not switch the backend of an existing credential profile casually: other backends may not decrypt it. Keep the original keyring accessible and plan migration/re-entry; there is no automatic migration. Never give sudo/keyring passwords to an agent, put them in project files or environment variables, use an empty keyring password, or bypass protection with `--password-store=basic`. The app rejects `basic_text` and has no plaintext fallback.

### Packaging and local distribution

`npm run package` uses `electron-builder --dir`, not an installer image, and does not upload a release. Keep the entire unpacked directory when distributing it. Typical outputs are `release/win-unpacked/`, `release/mac-arm64/Database Workspace.app` (x64: `release/mac/`), and `release/linux-unpacked/`.

Build an installer/image on its target platform; these commands never publish:

```sh
npm run build
npx electron-builder --mac dmg --arm64 --publish never  # Intel Mac: --x64
npx electron-builder --win nsis --x64 --publish never
npx electron-builder --linux AppImage --x64 --publish never
```

Current Linux x64 artifacts are `release/linux-unpacked/database-workspace` and `release/Database Workspace-0.1.0.AppImage`. Version **0.1.0** is a local unsigned build: no upload, automatic publishing or automatic commit.

```sh
npm run check:linux-artifacts
# Complete keyring / desktop acceptance; executable paths are positional:
npm run test:packaged:credentials -- release/linux-unpacked/database-workspace
npm run test:packaged:credentials -- "release/Database Workspace-0.1.0.AppImage"
```

The artifact checker requires `unsquashfs` (Ubuntu: `squashfs-tools`) and writes SHA-256 hashes, sizes, versions and architecture to `release/linux-artifacts.json`. Static inspection is not GUI/keyring acceptance. All 10 artifact checks and both complete credential acceptance commands passed in the current WSL environment.

The pinned `build.toolsets.appimage: 1.0.3` supplies the verified static runtime `dd6cebe`; **the current AppImage does not require host `libfuse2`**. It still needs accessible `/dev/fuse`, native FUSE mounting, a working unprivileged user-namespace sandbox, a display and an unlocked keyring. Retain the safe project AppRun installed by `scripts/after-pack.cjs` from `scripts/linux-app-run.sh`; do not substitute a sandbox-disabling launcher. Run natively: no `--no-sandbox` or extract-and-run workaround. Repair host prerequisites rather than bypassing them.

**Acceptance scope:** Linux x64 unpacked and native AppImage builds passed secure credential save/restart, unavailable/basic-backend refusal, SQLite and ordinary visible-window close checks on WSL2 + WSLg. This is not acceptance for every Linux desktop or architecture. No Windows/macOS or physical KDE/GNOME desktop acceptance was performed in this round; unit tests preserve their native backend choices. Existing Windows history and the [earlier macOS arm64 unsigned DMG acceptance](report/REPORT-2026-10-03T04-40-41-726Z.md) remain separate evidence. The 143 real external-database tests were skipped, **not passed**. Formal signing/notarization and publishing remain unverified; macOS distribution needs Developer ID/notarization/Gatekeeper checks, and Windows distribution should use publisher signing. Historical reports retain their original prerequisites, not the current launch instructions.

For detailed operation and test boundaries see the [Linux / WSL guide](docs/USER_GUIDE.md#linuxwsl-執行與安全憑證儲存) (Traditional Chinese).

## Using AI agents (MCP)

MCP is **disabled by default** and listens on loopback only. Enable it in _Settings → Agent / MCP_, copy the token, and configure your MCP client for Streamable HTTP:

```json
{
  "url": "http://127.0.0.1:7799/mcp",
  "headers": { "Authorization": "Bearer <desktop-generated-token>" }
}
```

- Each connection can be set to **Disabled / Read only / Read + Write**.
- An agent's write returns an `approvalId`; the desktop user must approve the original operation. Agents cannot approve themselves, and destructive operations are always asked every time.
- Database passwords and the token stay on the desktop and never appear in tool results, audit entries or error messages.

The full tool list, grant scopes and limits are in the [guide](docs/USER_GUIDE.md#mcp) (Traditional Chinese).

## Security

- Connection credentials are stored with the operating system's encryption (Electron `safeStorage`); there is no plaintext fallback.
- The renderer runs with `contextIsolation` and the sandbox, and reaches the main process only through a fixed IPC bridge.
- To report a vulnerability see [SECURITY.md](SECURITY.md). **Do not** post exploit details in a public issue.

## Development and testing

```sh
npm run typecheck          # type-check
npm test                   # unit tests (no database needed)
npm run integration:up     # start Docker test databases (PostgreSQL, MySQL, MariaDB, SQL Server, Redis)
npm run test:integration   # integration tests against real databases
npm run test:desktop:all   # desktop (Electron) smoke tests
npm run integration:stop
```

`npm test` skips every test that needs a real database, so **a green run does not prove database integration works**. The integration password is generated by `integration:up` into the git-ignored `.local/integration.env`.

GUI and MCP share one Command Bus, permission layer and set of services. Add new data operations through them; do not bypass permissions or touch the database from the renderer.

## Documentation

See [docs/README.md](docs/README.md) for the index (guide, feature notes, per-engine support and limits, how to add a database engine, and design/implementation history). Most of it is in Traditional Chinese.

## Contributing

Issues and pull requests are welcome; please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

[MIT](LICENSE)
