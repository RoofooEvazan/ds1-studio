# Developing DS1 Studio

TypeScript + React + WebGL2 in the front end, Rust + [Tauri 2](https://tauri.app) for the desktop shell. The same UI
also runs in a browser against a small dev server, which is the quickest way to work on it.

## Requirements

- Node.js 20+
- Rust (stable, via [rustup](https://rustup.rs)) for the desktop app
- Windows: the Visual Studio C++ build tools (WebView2 ships with Windows 10/11)
- Linux: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf` (Debian/Ubuntu names)
- A classic Diablo II 1.13/1.14 install, for anything beyond typechecking

## Browser / dev server

```bash
npm install
npm run dev        # http://localhost:5188
```

The dev server reads your game install directly (read-only) through `tools/vite-plugin-gamedata.ts`. Configure it in
`ds1studio.local.json` (git-ignored; copy `ds1studio.local.example.json`):

```json
{
  "gameDir": "C:/Program Files/Diablo II",
  "modDirs": ["C:/Program Files/Diablo II/MyMod"],
  "modMpqs": false,
  "saveDir": "C:/somewhere/to/write/test/saves"
}
```

- `modDirs`: mod folders (with a `data/` inside) layered over the game's MPQs. Saves go into the first one, or
  `saveDir` when set (handy for trying saves without touching a real mod).
- Objects and NPCs: the list of what each DS1 object id is comes from the game itself. NPCs from `MonPreset.txt`
  (+ `MonStats`/`MonStats2`/`SuperUniques`); objects through the game's fixed act/id → `objects.txt` table, which is
  only in the program code (`D2Common.dll` up to 1.13, `Game.exe` in 1.14). The mod's and the game's program files are
  mounted read-only as `bin/d2common.dll` / `bin/game.exe` and the table is found by its first entries
  (`src/game/objectCatalog.ts`). Special tiles are drawn as DS1 Studio's own labelled markers
  (`src/game/specialTiles.ts`).

File priority: mod `data/` folders → mod MPQs (if `modMpqs`) → `patch_d2.mpq` → `d2exp.mpq` → `d2data.mpq` →
`d2char.mpq`.

## Desktop app

```bash
npm run app:dev     # desktop app with hot reload
npm run app:build   # installers in src-tauri/target/release/bundle/
```

`app:build` also produces signed update packages, so it needs the updater key in the environment:

```bash
TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/ds1-studio.key)" TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npm run app:build
```

The native side (`src-tauri/src/lib.rs`) only reads inside the configured game/mod folders and only writes these
into the mod folder (keeping a `.bak` of anything it replaces): `.ds1/.dt1/.cof/.dcc/.dc6` under `data/global/`, `.txt`
under `data/global/excel/`, and presets under `data/ds1studio/`. On Linux, saves reuse existing folders/files whatever
their letter case.

## Tests

```bash
npm test           # parses every DS1/DT1 in your install; game-dependent tests skip without one
npm run typecheck
```

Game data location for tests: `D2_DIR` (default `C:/Program Files/Diablo II`) and `D2_MOD_DATA`.

## Releases

1. Bump the version in `package.json` and `src-tauri/tauri.conf.json` (keep them equal).
2. Commit, then tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. `.github/workflows/release.yml` builds the Windows (NSIS `.exe`, `.msi`) and Linux (`.AppImage`, `.deb`, `.rpm`)
   packages, publishes a GitHub release, and uploads `latest.json`, which the in-app updater reads.

Repository secrets used by the workflow:

| Secret | Purpose |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of the updater private key (`~/.tauri/ds1-studio.key`). Required: the app only installs updates signed with it. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password (empty if generated without one). |
| `WINDOWS_CERTIFICATE` / `WINDOWS_CERTIFICATE_PASSWORD` | Optional: a base64 `.pfx` code-signing certificate and its password. When present, the Windows installer and app are signed. |

Losing the updater key means existing installs can't verify future updates: keep a backup of `~/.tauri/ds1-studio.key`.

### Code signing ("unknown publisher")

Windows SmartScreen warns about unsigned installers from new publishers. Removing that needs a code-signing
certificate: an OV/EV certificate from a certificate authority, or Microsoft's
[Trusted Signing](https://learn.microsoft.com/azure/trusted-signing/) service. Add the certificate as the secrets above
and releases are signed automatically. Linux packages don't need this.

## Docs media

The README's screenshots and GIFs are generated from the running app:

```bash
# ds1studio.local.json pointing at a vanilla install (no mod folders)
npm run dev
node --experimental-websocket tools/capture-docs.mjs            # all scenes
node --experimental-websocket tools/capture-docs.mjs overview   # one scene
npx tsx tools/shortcuts-md.ts                                    # shortcut tables for the README
```

Scenes live in `tools/docs-scenes.mjs`. `CHROME=` points the script at Chrome/Edge if it isn't in the default place.

## Layout

| Path | What |
|---|---|
| `src/formats/mpq/` | MPQ reader: hash/block tables, Storm decryption, sectors, zlib + PKWARE explode (port of blast.c) |
| `src/formats/ds1.ts` | DS1 reader/writer, versions 1–18 (writes v18, byte-exact round trip) |
| `src/formats/dt1.ts`, `dt1Edit.ts`, `dt1Paint.ts` | DT1 reader, recolouring, pixel re-encoding |
| `src/formats/txtTable.ts` | Lossless .txt table editing |
| `src/formats/{cof,dcc,dc6}.ts` | Sprite formats |
| `src/game/` | Game logic: DT1 resolution, map documents/undo, presets, clipboard, compatibility checks, automap, level tables, packages |
| `src/render/` | Scene builder (placement + draw order), palette-indexed texture-array atlas, instanced WebGL2 renderer |
| `src/ui/` | React UI |
| `src/app/updates.ts` | Update check, bug-report links |
| `src-tauri/` | Desktop shell (Rust) |
| `tools/` | Dev server plugin, docs capture, helpers |

## How DT1s are chosen

Like the game: the DS1's row in `LvlPrest.txt` gives a `LevelId` and `Dt1Mask`; `Levels.txt` maps the level to a
`LvlTypes.txt` row, and each set mask bit *i* selects that row's `File i+1`. Presets shared by several levels
(`LevelId` 0) and presets not in LvlPrest at all get the level type whose files best match the DS1's embedded file
list; you can override the level type per map in the **Map** panel.
