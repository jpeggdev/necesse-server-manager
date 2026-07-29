# Tasks

- [~] Build v1 Necesse server GUI (Node/TS daemon on SERVER + Tauri client) per docs/superpowers/specs/2026-07-26-necesse-server-gui-design.html
- [ ] v2: world settings editor - stop server, unzip world, edit worldSettings.cfg via typed GUI form, rezip atomically with backup, restart
- [ ] Make daemon location/run-mode configurable and publish as a public repo per docs/superpowers/specs/2026-07-29-shareable-release-design.html
- [ ] Update All reinstalls every managed mod unconditionally (mod-installer.ts updateAll). The time_updated vs lastUpdated comparison exists only as the GET /api/mods/updates badge and never gates the loop. Skip mods with no newer workshop entry - noting Steam moves time_updated for any entry edit, so it indicates rather than proves a new jar
