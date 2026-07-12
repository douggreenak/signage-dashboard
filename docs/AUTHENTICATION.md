# Spotify authentication

How the Audio Flow Console talks to Spotify on your behalf, why the login flow is
shaped the way it is, and exactly how to fix it when it stops working.

> **TL;DR** — If the dashboard shows the amber **Connect Spotify** banner, click it,
> open the link it gives you in a browser, log in, and you are done. Everything
> else on this page is for when that does not "just work".

---

## Overview

Playback control and now-playing come from the **Spotify Web API**
(`https://api.spotify.com/v1`). Every call needs a short-lived **access token**.
We obtain and renew those tokens ourselves using **your own Spotify app** with the
**Authorization Code + PKCE** flow — there is no client secret anywhere on this box.

The moving parts:

| Piece | Path | Role |
| --- | --- | --- |
| OAuth helper | `/home/jellyfin/.config/spotify-signage/spotify_oauth.py` | Runs the one-time login (`auth`) and refreshes tokens (`token`). |
| Token store | `/home/jellyfin/.config/spotify-signage/token.json` | Holds the refresh token + last access token (chmod `600`). |
| Callback cert | `/home/jellyfin/.config/spotify-signage/cert.pem` + `key.pem` | Self-signed TLS cert for the HTTPS login callback. |
| URL redirector | `/home/jellyfin/.config/spotify-signage/redirector.py` | Optional short-URL helper for the CLI login path (port 8899). |
| Dashboard | `/home/jellyfin/signage-dashboard/server.js` | Reads `token.json`, refreshes access tokens, drives the **Connect** button. |

The dashboard (`signage-dashboard.service`) and the CLI player
(`/home/jellyfin/.local/bin/signage-play`) both read the **same** `token.json`, so
you only ever have to log in once per device.

---

## Your own Spotify app (PKCE, no secret)

We do **not** use a shared/vendor app. Authentication is done against an app the
admin created in the Spotify Developer Dashboard:

| Setting | Value |
| --- | --- |
| App name | **Signage Player** |
| Client ID | `99aa015e38634f389d6b8d1e16b3a578` |
| Flow | Authorization Code with **PKCE** (`code_challenge_method=S256`) |
| Client secret | **none** — not needed, not stored |

The client ID is a **public identifier**, not a secret; it is hard-coded in both
`spotify_oauth.py` and `server.js` (overridable with the `SIGNAGE_CLIENT_ID` env
var). PKCE replaces the client secret with a one-time `code_verifier` /
`code_challenge` pair generated per login, so there is no secret to leak. This is
why nothing in the config dir contains a Spotify app secret.

---

## The redirect URI (and why this exact one)

The **only** redirect URI that works — and the one registered on the Spotify app —
is:

```
https://172.16.50.100:8989/login
```

This looks fussy, but every part of it is forced by Spotify's **2025 "secure
redirect" policy**. That policy rejects the URIs you would naively reach for:

| Redirect you might try | Result | Reason |
| --- | --- | --- |
| `http://localhost:8989/login` | rejected | `localhost` hostnames are disallowed. |
| `http://172.16.50.100:8989/login` | rejected — *"Unsafe"* | plain `http` is only allowed for the loopback literal `127.0.0.1`, not a LAN IP. |
| `https://172.16.50.100:8989/login` | **works** | HTTPS + an explicit IP literal satisfies the policy. |

We use the **LAN IP** rather than `127.0.0.1` on purpose: you often complete the
login from a browser on a **different device** on the network (a laptop or phone),
so the callback server must be reachable at `172.16.50.100`, not only on the host
itself. To make that possible the dashboard starts the helper with
`SIGNAGE_BIND=0.0.0.0` (listen on all interfaces) and `SIGNAGE_REDIRECT` set to the
HTTPS URL above. Because the LAN IP requires HTTPS, the helper wraps its callback
socket in TLS using `cert.pem` / `key.pem`.

**Exact match matters.** Spotify compares the redirect URI it was sent against the
one registered on the app **character for character** — scheme, host, port, and
path all have to line up. If you change the host IP, the port, or the path you must
update the registered URI in the Spotify Developer Dashboard to match.

> The self-signed certificate means your browser will show a security warning the
> first time it hits `https://172.16.50.100:8989/login`. That is expected — it is
> your own machine. Click **Advanced → proceed / accept the risk** to continue.

---

## Scopes

The login requests exactly these scopes (from `spotify_oauth.py`):

| Scope | Why we need it |
| --- | --- |
| `user-read-playback-state` | Read what is playing / device list. |
| `user-modify-playback-state` | Play, pause, next, seek, transfer to the Signage device. |
| `user-read-currently-playing` | Now-playing card. |
| `playlist-read-private` | List your private playlists in the picker. |
| `playlist-read-collaborative` | List collaborative playlists. |
| `user-read-private` | Read account product type (Free/Premium) and name. |

If you ever add a feature that needs a new scope, you must **re-authenticate** —
scopes are baked into the tokens at login time and cannot be widened by a refresh.

---

## `token.json` (self-refreshing)

Path: `/home/jellyfin/.config/spotify-signage/token.json` — created `chmod 600`
(owner read/write only). It stores the fields Spotify returns plus a computed
expiry: `access_token`, `refresh_token`, `scope`, `token_type`, `expires_in`, and
`expires_at`.

- The **refresh token** is the long-lived credential; it is what "being logged in"
  actually means. `authStatus()` in the dashboard treats you as connected if and
  only if `token.json` has a `refresh_token`.
- The **access token** is short-lived (~1 hour, `expires_in` 3600) and is renewed
  automatically — you do not manage it by hand.
- When Spotify's refresh response omits a new refresh token, both the helper
  (`_save`) and the dashboard carry the **existing** refresh token forward, so it is
  never lost on a routine refresh.

> **Never paste the contents of `token.json` anywhere.** It contains live
> credentials. Refer to the file by path; do not print it. If you believe it
> leaked, remove the app's access in your Spotify account and re-authenticate (that
> revokes the old refresh token).

---

## `spotify_oauth.py` subcommands

```bash
# One-time login: start the HTTPS callback server, print the login URL,
# capture the returned code, exchange it, and save token.json.
python3 /home/jellyfin/.config/spotify-signage/spotify_oauth.py auth

# Print a valid access token to stdout (refreshing via the refresh token if needed).
python3 /home/jellyfin/.config/spotify-signage/spotify_oauth.py token
```

**`auth`** does the full PKCE dance:

1. Generates a `code_verifier` + S256 `code_challenge` and a random `state`.
2. Prints `LOGIN_URL <the Spotify authorize URL>` to stdout.
3. Starts a local callback server on port **8989** (HTTPS when the redirect is
   `https://…`, using `cert.pem`/`key.pem`), bound to `SIGNAGE_BIND` (the dashboard
   passes `0.0.0.0`). It waits up to **10 minutes** for you to log in.
4. On the redirect back to `/login`, it validates `state`, exchanges the `code` for
   tokens, and writes `token.json`. It prints `OK token saved`.

Relevant environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SIGNAGE_REDIRECT` | `http://127.0.0.1:8989/login` | The exact registered redirect URI. **The dashboard overrides this to `https://172.16.50.100:8989/login`.** |
| `SIGNAGE_BIND` | `127.0.0.1` | Callback bind address. Dashboard sets `0.0.0.0` so other LAN devices can reach it. |
| `SIGNAGE_CLIENT_ID` | the ID above | Override the Spotify app client ID. |

> The helper's built-in default redirect is the `http://127.0.0.1:8989/login` form.
> Spotify's policy does allow plain `http` for the `127.0.0.1` loopback literal, but
> that default still will not work here: it is **not** the URI registered on this app
> (Spotify requires an exact match, so an unregistered URI comes back as *"Invalid
> redirect URI"*), and a `127.0.0.1` callback is only reachable from the host itself,
> not from a laptop or phone on the LAN. **Always run `auth` with
> `SIGNAGE_REDIRECT=https://172.16.50.100:8989/login`** (the dashboard does this for
> you). The `auth` command also prints a `LISTENING (…) on 127.0.0.1:8989` line —
> that text is fixed; the socket really binds to whatever `SIGNAGE_BIND` says.

**`token`** reads `token.json`, refreshes against `refresh_token`, saves the result,
and prints the fresh access token. Its exit codes are useful in scripts:

| Exit | Meaning |
| --- | --- |
| `3` | No token / no refresh token — you must run `auth`. |
| `4` | `REFRESH_FAIL` — Spotify rejected the refresh (see troubleshooting). |

---

## How the dashboard uses tokens

`server.js` does **not** call `spotify_oauth.py token` per request. It keeps an
**in-memory** access token and only refreshes it when it is within **60 seconds** of
expiry (about once an hour). Combined with a global 429 backoff that honors
`Retry-After`, this is what keeps the box from being rate-limited by Spotify.

On each refresh the dashboard writes the merged token back to `token.json`
(preserving the refresh token) and stamps a fresh `expires_at`. If Spotify returns
**HTTP 400** to a refresh, the dashboard marks the session **unlinked** — that is the
signal that surfaces as the amber banner and as HTTP `401` on the playback
endpoints.

Auth-related endpoints (all under `http://172.16.50.100:8088`):

| Endpoint | Purpose |
| --- | --- |
| `GET /api/auth/status` | `{connected, scopes, expires_at}` — read straight from `token.json`. |
| `POST /api/auth/start` | Spawns `spotify_oauth.py auth` and returns `{login_url}`. |

---

## Re-authentication

You need to re-authenticate when: the **Connect Spotify** banner appears, playback
calls start returning `401`, the refresh token was revoked, or you changed the
account/scopes.

### Easy path — from the dashboard (recommended)

1. Open the dashboard at **http://172.16.50.100:8088**.
2. Click the amber **Connect Spotify** banner (or the avatar in the header). This
   fires `POST /api/auth/start`, which launches `spotify_oauth.py auth` with the
   correct redirect and bind, and returns a **login URL**.
3. Open that login URL in a browser and sign in to the Spotify account that owns the
   playlists. Approve the requested scopes.
4. The browser is redirected to `https://172.16.50.100:8989/login`. Accept the
   self-signed-cert warning if prompted. You will see **"Signage linked."**
5. The dashboard is polling `/api/auth/status` and clears the banner within a few
   seconds. Done — `token.json` is written and both the dashboard and `signage-play`
   pick it up automatically.

> The login window is open for **10 minutes**. If you miss it, just click
> **Connect** again to start a fresh one.

### CLI path — from a terminal on the host

Use this if the dashboard is down, or you are working over SSH.

```bash
SIGNAGE_REDIRECT=https://172.16.50.100:8989/login \
SIGNAGE_BIND=0.0.0.0 \
python3 /home/jellyfin/.config/spotify-signage/spotify_oauth.py auth
```

The command prints a `LOGIN_URL …` line. Open that URL in any browser on the LAN,
log in, and let it redirect to `https://172.16.50.100:8989/login` (accept the cert
warning). The terminal prints `OK token saved` and exits.

**Optional — avoid hand-copying the long URL.** The authorize URL is long and easy
to corrupt when typing it from another device. `redirector.py` lets you visit a
short URL instead: it 302-redirects any hit on port **8899** to the full authorize
URL in `AUTH_TARGET`.

```bash
# In a second terminal, paste the LOGIN_URL value as AUTH_TARGET:
AUTH_TARGET='<the full LOGIN_URL from the auth command>' \
  python3 /home/jellyfin/.config/spotify-signage/redirector.py
# Then on your phone/laptop just browse to:  http://172.16.50.100:8899/
```

After it prints `OK token saved`, stop the redirector (Ctrl-C). Verify with:

```bash
python3 /home/jellyfin/.config/spotify-signage/spotify_oauth.py token >/dev/null && echo "refresh OK"
```

(That prints the access token to stdout on success; redirect it to `/dev/null` so
the secret is not shown.)

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| **`INVALID_CLIENT: Invalid redirect URI`** on the Spotify login page | The `redirect_uri` sent does not exactly match one registered on the app. | Confirm you launched `auth` with `SIGNAGE_REDIRECT=https://172.16.50.100:8989/login`, and that the **same** string is in the app's Redirect URIs list in the Spotify Developer Dashboard. Match scheme/host/port/path exactly. |
| **`redirect_uri: Unsafe`** / the URI is refused before you can log in | Spotify's secure-redirect policy rejected the URI — e.g. plain `http` on the LAN IP, or a `localhost` hostname. | Use `https://172.16.50.100:8989/login`. Do not use `http://` for a non-`127.0.0.1` host, and do not use `localhost`. |
| Browser warns the connection is not private at `…:8989/login` | Self-signed callback certificate. | Expected. Click **Advanced → proceed**. It is your own machine. |
| **Connect** banner never clears; can't reach `…:8989/login` | Callback not reachable from the browser's device. | Log in from a device on the same LAN; ensure nothing blocks port 8989. Or run the login in a browser on the host itself. |
| Playback endpoints return `401`; banner reappears | Refresh failed with HTTP 400 → dashboard marks the session **unlinked**. | Re-authenticate (dashboard **Connect** or the CLI `auth`). |
| **`REFRESH_FAIL`** from `spotify_oauth.py token`, or *"Refresh token revoked"* | The refresh token was invalidated — the app's access was removed in the Spotify account, the password changed, or it went unused too long. | Re-authenticate. This mints a brand-new refresh token and overwrites `token.json`. If it persists, open your Spotify account → **Apps** and remove *Signage Player*, then log in again. |
| `token` exits `3` (`NO_TOKEN` / `NO_REFRESH`) | `token.json` is missing or has no refresh token. | Run the `auth` flow — you have never completed login on this box, or the file was deleted. |
| Login succeeds but a feature says it lacks permission | The token predates a scope change. | Re-authenticate so the new scope is included. |

Quick health checks:

```bash
# Is the dashboard considering us linked? (no secrets in this output)
curl -s http://172.16.50.100:8088/api/auth/status

# Does a refresh currently work end-to-end?
python3 /home/jellyfin/.config/spotify-signage/spotify_oauth.py token >/dev/null && echo OK
```

---

## Obsolete — do not use

- **`spotify_player`** (the ~205 MB binary in `~/.local/bin`) is **abandoned**. Its
  auth was hardwired to a different client ID that Spotify now rejects. Do not use
  it for login or playback.
- **`signage-list`** is obsolete because it shells out to `spotify_player`. Use the
  dashboard playlist picker (`GET /api/playlists`) instead.

The current, supported auth path is `spotify_oauth.py` + `token.json`, driven either
by the dashboard **Connect** button or the CLI `auth` command described above.

---

## Quick reference

| Port | Used for | When it's open |
| --- | --- | --- |
| 8088 | Dashboard / web UI | always |
| 8989 | OAuth callback (HTTPS) | only during a login |
| 8899 | OAuth short-URL redirector | only if you run `redirector.py` during a login |

| File | Notes |
| --- | --- |
| `~/.config/spotify-signage/spotify_oauth.py` | `auth` + `token` subcommands. |
| `~/.config/spotify-signage/token.json` | Tokens, `chmod 600`. **Never print it.** |
| `~/.config/spotify-signage/cert.pem` / `key.pem` | Self-signed cert for the HTTPS callback (`key.pem` is `600`). |
| `~/.config/spotify-signage/redirector.py` | Optional short-URL redirect during CLI login. |
| `/home/jellyfin/signage-dashboard/server.js` | Token cache + `/api/auth/*` endpoints. |
