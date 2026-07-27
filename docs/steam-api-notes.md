# Steam Workshop API notes

What the daemon uses, what needs a key, and the one caveat that matters.
Probed live against Necesse's workshop app id `1169040` (config: `workshopAppId`).

Implementation: `daemon/src/steam-workshop.ts`. `fetch` is injected the same way
`spawn` is injected into `steamcmd.ts`, so no test ever reaches the network.

## Which endpoints need a key

| Endpoint | Key | Used by |
| --- | --- | --- |
| `ISteamRemoteStorage/GetPublishedFileDetails/v1/` | **no** | `GET /api/mods/updates`, name resolution for `POST /api/mods` |
| `IPublishedFileService/QueryFiles/v1/` | **yes** | `GET /api/workshop/search` |

`QueryFiles` returns **403 Forbidden** with no `key=`. That bare 403 reads like a
broken daemon, so `search()` checks for a configured key first and fails with
`kind: "not-configured"` (surfaced as HTTP 503) before any request goes out.

## GetPublishedFileDetails (keyless)

`POST https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/`

Form-encoded body (`application/x-www-form-urlencoded`):

```
itemcount=2
publishedfileids[0]=3731244177
publishedfileids[1]=3754847143
```

Response: `response.publishedfiledetails[]`, one entry per requested id:

| Field | Notes |
| --- | --- |
| `publishedfileid` | string |
| `result` | `1` = ok. `9` = file not found. Anything but 1 carries no usable title or timestamp. |
| `title`, `description` | |
| `preview_url` | thumbnail |
| `time_updated` | **unix seconds** |
| `file_size` | sometimes a string, sometimes a number - coerce |
| `subscriptions`, `banned`, `visibility` | |

An id Steam does not know still comes back, with `result: 9`. The module drops
those rather than emitting a blank item, so the caller matches by id and treats a
miss as "Steam does not know this one".

### What gets dropped, and what does not

- **`result !== 1`** - dropped. No usable title or timestamp.
- **`banned: true`** - dropped. A banned item comes back with `result: 1` and a
  perfectly good title, so it has to be excluded explicitly; steamcmd cannot
  download one anonymously, so keeping it would badge an update that can never
  install and resolve a name for an add that is going to fail. There is
  therefore no `banned` field on `WorkshopItem` - a banned entry is simply
  absent.
- **`visibility`** - **not** filtered. 0 is public, 1 friends-only, 2 private,
  3 unlisted. Unlisted items are still downloadable by direct id and mod authors
  do use that, so filtering on visibility would reject mods that install fine.

Not confirmed without a live call: what Steam returns for a *private* item to an
anonymous caller. It is most likely `result: 9` (which is already dropped), but
that was not probed.

## QueryFiles (needs a key)

`GET https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/`

| Param | Notes |
| --- | --- |
| `key` | Steam Web API key, from https://steamcommunity.com/dev/apikey |
| `appid` | `1169040` |
| `query_type` | `9` = ranked by trend, `0` = ranked by vote, `1` = ranked by publication date |
| `search_text` | omit when browsing rather than searching |
| `numperpage` | clamped to 50 by the daemon |
| `cursor` | start at `*`; feed `response.next_cursor` back for the next page |
| `return_metadata` | `true`, or the entries come back without titles etc. |

Response shape matches the keyless endpoint: `response.publishedfiledetails[]`,
plus `response.total` and `response.next_cursor`. Entries here have no `result`
field.

Steam **echoes the cursor back unchanged on the last page** rather than omitting
it, so paging on `next_cursor` alone loops forever. The module returns
`nextCursor: null` when the returned cursor equals the one that was sent.

The key travels in the query string. Nothing may interpolate the built URL into
an error message: this API has no authentication, so every error body is
readable by anything on the LAN. Error text names the endpoint instead, and a
test asserts the key never appears in a search failure.

## The `time_updated` caveat

`time_updated` moves for **any** edit to the workshop entry - a retitle, a
description tweak, a new screenshot - not only for a new file. So
`GET /api/mods/updates` reporting `updateAvailable: true` means *the workshop
entry changed after this daemon installed the mod*. That is an indication an
update may exist, not proof of a new jar. There is no cheap keyless way to get
the jar's own hash or version, so this is the best available signal.

`updateAvailable` requires both timestamps to parse; a registry entry with an
unreadable `lastUpdated` reports no update rather than guessing in either
direction.

## Where the key lives

`DaemonConfig.steamApiKey`, default `""`. Hand-edited in `config.json` on the
server, exactly like `javaExe` and the other sensitive fields.

- **Never in git.** `scripts/seed/config.json` ships an empty string, and the
  deploy script only seeds `config.json` when none exists on the box, so a real
  key is never clobbered either.
- **Never over the API.** `GET /api/config` returns `PublicDaemonConfig`, which
  drops `steamApiKey` entirely and adds `steamApiKeyConfigured: boolean`.
  `PUT /api/config` returns the same redacted shape, and `steamApiKey` is not in
  `ALLOWED_CONFIG_KEYS`, so it cannot be set remotely.

## Failure kinds

`WorkshopError.kind` distinguishes three cases the caller genuinely needs apart,
mapped to status codes in `http.ts`:

| kind | Meaning | HTTP |
| --- | --- | --- |
| `not-configured` | no key, and the operation needs one | 503 |
| `unreachable` | no response at all: DNS, connect, 10s timeout | 502 |
| `upstream` | Steam answered with an error status or an unreadable body | 502 |

Never 200 - a Steam outage must not be indistinguishable from "nothing to
report". The underlying message is always carried through.

Every request carries `AbortSignal.timeout(10s)`. Neither Node's fetch nor
Fastify bounds a connection that goes quiet, so without it a wedged Steam would
hold an HTTP handler open for the life of the daemon. A test asserts the signal
is attached, because a fake fetch always answers and would otherwise never
notice its removal.

## Design constraints worth keeping

**`GET /api/mods` does not call Steam.** The mod list is read off disk and has to
keep working when Steam is down; update badges are a second call the client
makes afterward. A Steam outage therefore costs badges, not the mod list.

**Name resolution in `POST /api/mods` runs before the `requireStopped` /
`requireNoActiveTask` guards, not after.** `requireNoActiveTask` is only an
interlock if checking the set and reserving a slot are atomic, and `runTask`
reserves synchronously - so the pair holds exactly as long as nothing awaits
between them. Putting the Steam round trip there let two nameless adds both pass
the check while both waited on Steam, and both then ran steamcmd against
`modsDir` at once. Hoisting the await above the guards removes the window
instead of policing it: nothing enters `activeTasks` before `runTask`, so no
hung or failed resolution can strand an entry and there is no reservation to
release. The cost is that a request destined to be refused may still spend one
read-only Steam call first. Adds carrying an explicit name skip resolution and
reach the guards synchronously, exactly as before.
