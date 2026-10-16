# Just Us — love-chat

A private, two-person chat ("WhatsApp for two") for Ammar and Mena.
Static frontend (plain HTML/CSS/JS, no build step) talking to the
[`love-api`](../love-api) Cloudflare Worker's `/chat/*` routes.

Live: https://menaammarpro.github.io/love-chat/

## How it works

- **Register once each** (name + passphrase). The room holds exactly two
  people; after that registration is locked forever.
- **Sign in** with the same name + passphrase; the API answers with a
  30-day Bearer token (stored in this browser's localStorage only).
- Messages, little emoji reactions, typing pulses and read receipts poll
  every few seconds — no websockets, no third-party chat service.

## Frontend ⇄ API map

| UI action | API call |
| --- | --- |
| Open the room | `POST /chat/register` |
| Unlock | `POST /chat/login` |
| Presence + unread | `GET /chat/state` (every 10s) |
| New messages | `GET /chat/messages?after=<ts>` (every 3s) |
| Send | `POST /chat/messages` |
| Tap a bubble → react | `POST /chat/react` |
| Typing | `POST /chat/typing` (throttled) |
| Seen | `POST /chat/read` |

Local dev against a stub backend:
`index.html?api=http://127.0.0.1:8787` (wrangler dev).

## Storage keys

- `mena-chat-token` — Bearer token
- `mena-chat-name` — display name (cosmetic)

"Leave" wipes both.

Made with love, just for you ♥
