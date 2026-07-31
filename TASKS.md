# Tasks

- [x] Build v1 Necesse server GUI (Node/TS daemon on SERVER + Tauri client) per docs/superpowers/specs/2026-07-26-necesse-server-gui-design.html
- [x] v2: world settings editor - stop server, unzip world, edit worldSettings.cfg via typed GUI form, rezip atomically with backup, restart
- [x] Make daemon location/run-mode configurable and publish as a public repo per docs/superpowers/specs/2026-07-29-shareable-release-design.html
- [~] Windows installer for the daemon per docs/superpowers/specs/2026-07-30-daemon-installer-design.html - bundles a private Node, runs the setup wizard, registers the boot task, and never deletes the state directory on uninstall
- [ ] Update All reinstalls every managed mod unconditionally (mod-installer.ts updateAll). The time_updated vs lastUpdated comparison exists only as the GET /api/mods/updates badge and never gates the loop. Skip mods with no newer workshop entry - noting Steam moves time_updated for any entry edit, so it indicates rather than proves a new jar
- [ ] UI for editing the server's launch parameters per world (owner, pausewhenempty, and the rest of Server.jar's command line) - decide which belong to the world and which to the daemon config, and how they interact with worldSettings.cfg
