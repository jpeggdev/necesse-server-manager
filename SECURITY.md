# Security Policy

## Reporting a vulnerability

Please report security issues privately, not as a public issue.

Use GitHub's private vulnerability reporting: go to the
[Security tab](https://github.com/jpeggdev/necesse-server-manager/security)
and choose "Report a vulnerability". That opens a private thread visible only
to you and the maintainer.

Include what you have. A rough report beats none:

- what an attacker can do, and what access they need to start
- the steps to reproduce it, ideally with the exact request, config value, or
  input string
- which version you tested, and whether you used the installer or the zip

This is a small hobby project with one maintainer. Expect a first reply within
about a week. If a fix is warranted it lands in the next release, and you get
credit in the release notes unless you would rather not.

## Supported versions

| Version | Supported |
|---|---|
| 1.1.x | Yes |
| 1.0.x | No, upgrade to 1.1.x |

Only the latest release gets fixes. There are no backports.

## What this tool is, and what that means

The daemon spawns processes and writes files on the machine it runs on. That
is its job. It is built for a LAN you trust and nothing more. The README's
Security section covers the day to day guidance; this section draws the line
between a design decision and a defect.

### Known and by design, not vulnerabilities

Reporting these is welcome as a discussion, but they are documented tradeoffs
rather than bugs:

- **Traffic is plain HTTP, not TLS.** The access token is a shared secret sent
  in the clear. Anyone who can read traffic on that network segment can read
  the token.
- **An empty `authToken` disables authentication entirely.** This is a
  documented opt-out for a single-user home LAN, and it is also the upgrade
  path for a `config.json` written before the token existed.
- **A valid token grants full control of the game server.** Starting, stopping,
  editing worlds, installing mods, and setting launch options are all the
  point of the tool. There are no privilege tiers.
- **The daemon runs as SYSTEM when registered as a boot task.** This is
  deliberate, so that an unattended reboot brings the server back without a
  stored password. The game's data directory is passed explicitly with
  `-datadir` so it does not depend on which account launched it.
- **Exposing the daemon to the internet.** Do not port forward it. Anything
  that follows from doing so is out of scope.

### In scope

- Serving a request without a valid token when a token is configured, over
  HTTP or on the WebSocket upgrade.
- Injection into the game server's command line. String launch option values
  reject `-`, `+`, `"` and `'` anywhere in the value, because the game's own
  argument parser rejoins argv into a single string and resynchronises on the
  next `-` or `+` it finds, so a hyphen in the middle of a word starts a new
  option. A value that defeats this and makes the game see an option the
  daemon did not intend is a vulnerability.
- Setting `-datadir`, `-world` or `-nogui` from user input. These are owned by
  the daemon and are protected twice over: they are filtered out of user
  options, and the daemon writes its own arguments last so the game's
  last-flag-wins parser resolves to the daemon's value.
- Path traversal or arbitrary file write through a world name, mod name,
  uploaded jar, or any other request field.
- Anything that lets a request reach code execution beyond the game server
  process itself, given that the daemon may be running as SYSTEM.
- Installer or scheduled task behaviour that widens exposure past what the
  operator agreed to, such as a firewall rule broader than the daemon's port.
- A vulnerability in the Node runtime bundled by the installer. See below.

## The bundled Node runtime

The installer ships its own Node build, pinned in `installer/node-version.txt`.
That runtime is private to the install directory, so **a user cannot patch it
themselves**. A stale pin is a vulnerability nobody on the other end can do
anything about, which makes it the maintainer's problem rather than theirs.

Checking the pin against the latest 22.x is part of the release checklist. If
you notice it lagging behind a Node release that fixes a security issue, that
is worth reporting.

The zip release uses whatever Node is already on the machine and is not
affected.

## Your access token

The token lives in `config.json` in the state directory, which is
`%PROGRAMDATA%\NecesseServerManager` unless `NECESSE_MANAGER_DATA` says
otherwise.

To rotate it: stop the daemon, edit `authToken` in `config.json`, start the
daemon, then update the token in the client's settings. Write the file without
a byte order mark.

If you have pasted your token into a chat, a screenshot, an issue, or a log
you shared, treat it as compromised and rotate it.
