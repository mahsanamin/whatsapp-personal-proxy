# wpp CLI

`wpp` is a dependency-free Python CLI for humans and agents using WhatsApp Personal
Proxy from another machine. It writes JSON to stdout, structured errors to stderr, and
exits nonzero on failure.

The server runs on one machine (the one your phone is linked to). Every other machine
runs `wpp`, holds its own API token, and talks to the server over REST.

## Install and connect

Python 3.9 or newer is the only requirement. Copy the install command shown under
**API Keys** in the web console, or run:

```bash
mkdir -p ~/.local/bin
curl -fsSL http://SERVER:3300/api/cli/wpp -o ~/.local/bin/wpp && chmod 755 ~/.local/bin/wpp
```

For a system-wide install:

```bash
sudo curl -fsSL http://SERVER:3300/api/cli/wpp -o /usr/local/bin/wpp && sudo chmod 755 /usr/local/bin/wpp
```

From a repository checkout, `./wpp install --path /usr/local/bin/wpp` does the same.

In the web console open **API Keys**, create one key for this machine or agent, and copy
it. Then connect; the prompt hides the token:

```bash
wpp connect http://SERVER:3300
```

The connection is tested against `/api/auth/test` before it is saved, so a bad URL or a
revoked token fails immediately rather than on your first real command. Profiles and
tokens live in `~/.config/wpp/config.json` with mode `0600`. **Create a separate key per
machine** so one can be revoked without disturbing the others.

Named profiles support more than one server or identity:

```bash
wpp connect http://100.100.50.3:3300 --name home
wpp profiles
wpp use home
wpp --profile home status
```

Non-interactive setups can pipe the token instead of typing it:

```bash
echo "$WPP_TOKEN" | wpp connect http://SERVER:3300 --token-stdin
```

## Catching up

```bash
wpp brief                       # everything unread, ranked, with previews
wpp brief --dms-only --count 5
wpp brief --since 2026-08-29T09:00:00Z
wpp read "Family"               # mark read so the next brief skips it
```

`brief` is one round trip and is the right first command of a session. Chats are
ranked by messages that @mention you, then replies to something you sent, then
DMs, then group volume; muted chats sink.

Unread is tracked here, not by WhatsApp — everything newer than a chat's
`last_read_at`. If nothing marks a chat read it stays unread forever, so use
`wpp read` (or `wpp history --mark-read`) once you have dealt with it.

For the full agent-facing contract, see [`llm-reference.md`](llm-reference.md).

## Checking the link

```bash
wpp status            # profile, scopes, and whether WhatsApp is linked
wpp health            # server health, no authentication needed
wpp auth              # what this token is allowed to do
```

If `status` reports WhatsApp is not linked, it tells you the console URL to open. Linking
is always done in the web console by scanning a QR code — the CLI never handles that.

## Reading

```bash
wpp chats                              # every chat the server has seen
wpp chats --type group                 # groups only
wpp chats --type dm --search alice     # find a DM by contact name
wpp groups --live                      # ask WhatsApp directly, not the local mirror
wpp history "Family" --count 100       # read a group by name
wpp history +971501234567 --count 50   # read a DM by number
wpp history 1203630001@g.us                          # ...or by raw JID
wpp history "Family" --after 2026-08-01T00:00:00Z    # only since a timestamp
wpp search "invoice"                   # search stored message bodies
wpp search "invoice" --chat "Family"   # ...within one chat
wpp resolve "Family"                   # show which JID a name resolves to
```

`history` returns oldest-first so it reads like a transcript. Reading requires the
`channels:read` scope.

A DM can be filed under a phone-number JID (`...@s.whatsapp.net`) or a device-linked one
(`...@lid`) depending on which the sender used. The server reads across both, so
`wpp history +971501234567` returns the whole conversation either way.

## Writing

Writes are protected twice: the server must allow the destination, and the CLI requires
interactive confirmation or `--yes`.

```bash
wpp send +15555550100 'note to self'     # a PERSONAL_NUMBERS number
wpp send +971501234567 'hello'           # a whitelisted number
wpp send "Family" 'on my way'            # a group, by name
wpp send 1203630001@g.us 'on my way'     # a group, by JID
wpp send "Family" --text-stdin < message.txt
```

`send` picks the endpoint for you: groups go to `/api/groups/send`, your own numbers to
`/api/personal/send`, everyone else to `/api/others/send`. Force one with
`--route personal|others|group`.

**The CLI can only message allowed destinations.** A token reaches your own
`PERSONAL_NUMBERS` plus whatever is on the allow list — people *and* groups alike. Anything
else comes back `NOT_WHITELISTED`. Manage the list in the web console under **Allow list**,
or with `wpp whitelist` below. The console itself is not restricted this way: from the
browser you can message anyone.

Agents should use `--yes` only after the user has authorized that exact message and
recipient. For multiline or shell-sensitive text, use `--text-stdin`.

### Files, photos and voice notes

```bash
wpp send "Family" --file holiday.jpg --caption "from the trip" --yes
wpp send "Family" --file clip.mp4 --caption "watch this" --yes
wpp send "Family" --file report.pdf --yes                  # sent as a document
wpp send "Family" --file note.ogg --voice --yes            # a WhatsApp voice note
wpp send "Family" --file loop.mp4 --gif --yes              # plays as a looping GIF
wpp send "Family" --file sticker.webp --kind sticker --yes
```

How WhatsApp presents the file is taken from its type; `--kind` overrides that
(`image`, `video`, `audio`, `document`, `sticker`).

`--voice` is its own flag because WhatsApp treats a voice note and an audio
file as different things: a voice note shows a waveform and plays inline. It
wants **Opus in an Ogg container** — other codecs upload, but some clients will
not play them inline. To convert:

```bash
ffmpeg -i input.m4a -c:a libopus -b:a 32k note.ogg
wpp send "Family" --file note.ogg --voice --yes
```

Documents up to 100 MB; other media follows WhatsApp's own ~16 MB ceiling.

### Replying, reacting, editing, deleting

```bash
wpp send "Family" 'on my way' --reply-to 3EB0AB… --yes   # quote a message
wpp send "Family" --file map.png --reply-to 3EB0AB… --yes
wpp react 3EB0AB… 👍 --yes
wpp react 3EB0AB… --yes                                   # remove your reaction
wpp edit 3EB0AB… 'corrected text' --yes                   # your own messages only
wpp delete 3EB0AB… --yes                                  # deletes for everyone
```

Message ids come from `wpp history`. Editing and deleting work only on your own
messages, and WhatsApp allows both only for a limited window after sending.

### Downloading media you received

Media is never downloaded automatically — metadata is stored and the bytes are
fetched only when you ask.

```bash
wpp media get "Family" 3EB0AB… --out photo.jpg   # download to a file
wpp media save "Family" 3EB0AB…                  # keep a copy on the server
```

### Read receipts and typing

```bash
wpp receipts "Family"                 # send blue ticks for what you have read
wpp typing "Family" --state composing # show a typing indicator
wpp typing "Family" --state recording # ...or a recording one
```

`wpp read` is local bookkeeping and invisible to anyone else. `wpp receipts`
is the real thing the sender sees.

### Whitelist

Sending to anyone who is not one of your own numbers requires them on the whitelist.

```bash
wpp whitelist list
wpp whitelist add +971501234567 --label "Alice"
wpp whitelist remove +971501234567 --yes
```

`list` needs `others:whitelist:read`; `add`/`remove` need `others:whitelist:manage`.

## Watching

```bash
wpp watch                       # every incoming message, one JSON object per line
wpp watch --chat "Family"       # one chat only
wpp watch --count 10            # stop after 10 messages
```

`watch` streams Server-Sent Events from `/api/events` and prints newline-delimited JSON,
so it pipes straight into `jq`:

```bash
wpp watch | jq -r '.data | "\(.jid): \(.body)"'
```

## Output contract

Every command prints one JSON object.

```json
{"success": true, "data": {...}, "meta": {"count": 12}}
```

Failures go to stderr and exit 1:

```json
{"success": false, "error": {"code": "TARGET_NOT_FOUND", "message": "No chat matches 'Nobdy'..."}}
```

Use `--pretty` before the subcommand for indented JSON. Stable error codes worth handling:

| Code | Meaning |
|---|---|
| `NOT_CONNECTED` | No profile saved; run `wpp connect` |
| `TARGET_NOT_FOUND` | The name matched no chat |
| `AMBIGUOUS_TARGET` | The name matched several chats; `error.details.candidates` lists them |
| `NOT_WHITELISTED` | Recipient is not on the whitelist |
| `NOT_PERSONAL_NUMBER` | Number is not in `PERSONAL_NUMBERS` |
| `MISSING_SCOPE` | The token lacks the scope this call needs |
| `WA_DISCONNECTED` | WhatsApp is not linked; scan the QR code in the console |
| `CONFIRMATION_REQUIRED` | A write was attempted non-interactively without `--yes` |

## Escape hatch

```bash
wpp request GET /api/channels
wpp request POST /api/whitelist --data '{"jid":"+971501234567","label":"Alice"}' --yes
```

## Environment variables

| Variable | Effect |
|---|---|
| `WPP_CONFIG` | Config file path (default `~/.config/wpp/config.json`) |
| `WPP_PROFILE` | Profile to use, same as `--profile` |
| `WPP_TOKEN` | Token for `wpp connect`, instead of the hidden prompt |
