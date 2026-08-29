# WPP — LLM reference

Point an agent at this file. It covers everything needed to read and send
WhatsApp through `wpp`, and what each command costs.

Every command prints one JSON object to stdout. Failures print to stderr and
exit nonzero.

```json
{ "success": true, "data": { ... }, "meta": { "count": 12 } }
{ "success": false, "error": { "code": "NOT_WHITELISTED", "message": "..." } }
```

Output is **compact by default** — trimmed to what a reader can act on. Pass
`--verbose` on `chats`, `history` or `search` for the full stored records
(media keys, mime types, sha256s, internal ids). You rarely want those.

## Start here

```bash
wpp brief
```

One call, one round trip. Returns everything unread, ranked by what actually
matters, with a short transcript per chat. This is the right first command of
any session — prefer it over listing chats and fetching each one.

```json
{
  "generated_at": "2026-08-29T13:55:00Z",
  "totals": { "chats": 8, "messages": 96, "mentions": 2, "replies": 1 },
  "chats": [
    {
      "jid": "923214461264@s.whatsapp.net",
      "type": "dm",
      "display_name": "Ahsan Primary",
      "unread_count": 3,
      "unread_mentions": 0,
      "replies_to_me": 0,
      "last_activity": "2026-08-29T12:33:06Z",
      "messages": [
        { "from": "Ahsan Primary", "at": "2026-08-29T12:33:06Z", "text": "Yo Yo" }
      ]
    }
  ]
}
```

Ranking, highest first: messages that **@mention you**, then **replies to
something you sent**, then **DMs**, then group volume. Muted chats sink to the
bottom and are excluded unless `--include-muted`.

Useful flags: `--count` (chats, default 15), `--messages` (per chat, default 5),
`--since <ISO>` (only newer activity), `--dms-only`.

## Unread is real, and you must maintain it

WhatsApp never tells this server that you read something, so unread is tracked
locally: everything newer than the chat's `last_read_at`.

```bash
wpp read "Ahsan Primary"          # mark read; the next brief skips it
wpp history "Family" --mark-read  # read and clear in one step
```

**If nothing ever marks a chat read, every brief reports its entire history as
unread.** After summarising a chat for the user, mark it read.

## Reading

```bash
wpp chats --type group                 # list chats
wpp chats --search alice --type dm
wpp history "Family" --count 50        # a chat, oldest-first, reads as a transcript
wpp history +923214461264 --count 50
wpp history "Family" --after 2026-08-01T00:00:00Z
wpp search "invoice"                   # across everything
wpp search "invoice" --chat "Family"
wpp resolve "Family"                   # what JID does this name mean?
```

A target may be a chat name, a phone number, or a raw JID. Names are resolved
server-side; if one is ambiguous the command **refuses** and lists the
candidates in `error.details.candidates` rather than guessing which of several
people to open.

A contact has two WhatsApp addresses (a phone-number JID and an `@lid` one).
This is handled for you: one chat, one row, one name, and reads span both.

## Sending

```bash
wpp send "Family" 'on my way' --yes
wpp send +923214461264 'hello' --yes
wpp send "Family" --text-stdin --yes < message.txt
```

**Sending is not reversible.** Use `--yes` only after the user has authorised
that exact recipient and that exact message. Without it, a non-interactive call
fails with `CONFIRMATION_REQUIRED` — that is the intended safety net, not an
error to route around.

A token may only message the owner's own numbers plus the allow list, groups
included. Anything else returns `NOT_WHITELISTED`; the owner adds people in the
web console under **Allow list**. Do not try other routes to get around it.

## Live

```bash
wpp watch --count 10          # newline-delimited JSON, one object per message
wpp watch --chat "Family"
```

## Cost and etiquette

| Command | Round trips | Notes |
|---|---|---|
| `brief` | 1 | Everything unread, ranked. Start here |
| `chats` | 1 | |
| `history` | 1, +1 with `--mark-read` | Name targets add 1 to resolve |
| `search` | 1 | `--chat` adds 1 to resolve |
| `send` | 1–2 | Name targets add 1 to resolve |

Prefer `brief` over `chats` followed by a `history` per chat. Pass a JID rather
than a name when you already have one — it skips the resolve call entirely.

## Error codes worth branching on

| Code | Meaning |
|---|---|
| `NOT_CONNECTED` | No profile saved; the user must run `wpp connect` |
| `WA_DISCONNECTED` | WhatsApp is not linked; the user must scan a QR in the console |
| `TARGET_NOT_FOUND` | No chat matched that name |
| `AMBIGUOUS_TARGET` | Several matched; candidates are in `error.details` |
| `NOT_WHITELISTED` | Recipient is not on the allow list |
| `NOT_PERSONAL_NUMBER` | Not one of the owner's own numbers |
| `MISSING_SCOPE` | This token lacks the scope; the owner must issue a new one |
| `CONFIRMATION_REQUIRED` | A write was attempted without `--yes` |

## Checking the connection

```bash
wpp status      # profile, scopes, and whether WhatsApp is linked
```

`data.whatsapp.linked` is the field that matters. `status` alone cannot
distinguish "never linked" from "linked, reconnecting" — both read `connecting`.
When not linked, `data.next` says what the user has to do.
