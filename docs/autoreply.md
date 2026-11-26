# Auto-reply

The server can answer incoming WhatsApp messages by itself, using a **rule set**: a JSON
template that says who may be answered, which messages match, and what to send back.
You upload, edit, validate, test and download rule sets on the console's **Auto-reply**
page, or through the API (see "API" below).

This sends real messages from your number, so everything starts switched off and the
safety rules below cannot be turned off by a template.

## Turning it on

Three things must all be true before anything is sent:

1. The **global switch** on the Auto-reply page is on. It is off on a new install.
2. A rule set is **active**. Only one can be active at a time; activating one
   deactivates the rest.
3. That rule set's **mode** is `live`. The modes are:
   - `off`: does nothing.
   - `dry_run`: decides as if it were live and logs "would reply" with the text, but
     sends nothing.
   - `live`: sends.

A new or uploaded rule set starts inactive in `dry_run`. **Any edit puts a live rule set
back into `dry_run`**, so a change is always seen in the log before it sends.

Only the web console can turn the global switch on or put a rule set live. An API key
with `autoreply:manage` can create, edit, test and activate rule sets in `dry_run`, but
it can never make the server send. That keeps API keys limited to the people their send
scopes already allow. Rule sets with a model-written reply (`"type": "llm"`) need more:
the model is shown recent messages of the chat, so a key that could steer it could read
chats it has no scope for. Creating, editing, activating and testing them takes the
console, or a key that has `autoreply:llm` as well as `autoreply:manage`. Give a key
`autoreply:llm` only where you would give it `channels:read`. Without it, the decision
log hides the text of replies a model may have written (`reply_redacted: true`). Even
with it, a key cannot put a rule set live. A key also never sees saved contact names in
a test result.

The safe way to start: upload a rule set, activate it in dry run, turn the global switch
on, watch the decision log for a while, then switch the rule set to live.

## A complete example

```json
{
  "format": 1,
  "name": "FAQ by keyword",
  "version": "1.0.0",
  "description": "Answer common questions for people on the allow list.",
  "scope": {
    "allowlist": true,
    "all_dms": false,
    "chats": ["120363000000000001@g.us"],
    "blocklist": ["15555550199@s.whatsapp.net"]
  },
  "options": {
    "timezone": "Asia/Singapore",
    "cooldown_minutes": 240,
    "once_per_chat": false,
    "quiet_hours": { "start": "23:00", "end": "07:00" },
    "active_hours": null,
    "pause_after_manual_reply_minutes": 30,
    "max_replies_per_contact_per_hour": 3,
    "max_replies_per_contact_per_day": 10,
    "conversation": {
      "gap_minutes": 30,
      "max_replies": 5,
      "backoff_base_minutes": 1,
      "handoff_text": "Thanks {first_name}, I'll get back to you personally."
    },
    "flood": { "max_messages": 8, "window_seconds": 60, "mute_minutes": 360 },
    "loop": { "reply_within_seconds": 3, "streak": 3, "mute_minutes": 1440 }
  },
  "rules": [
    {
      "id": "price",
      "match": { "keywords": ["price", "how much"], "keywords_mode": "any" },
      "response": { "type": "text", "text": "Hi {first_name}, prices are at https://example.com/prices" }
    },
    {
      "id": "order",
      "match": { "regex": "\\border\\s*#?\\d{4,10}\\b" },
      "response": { "type": "text", "text": "Thanks, I'll check that order and reply soon." },
      "cooldown_minutes": 60
    }
  ],
  "fallback": {
    "id": "other",
    "response": { "type": "text", "text": "I'll reply as soon as I can." },
    "once_per_chat": true
  }
}
```

Two ready-made templates are in `server/templates/autoreply/`: `away-message.json`
(answers anything outside working hours, once per conversation) and
`faq-keywords.json` (answers by keyword and hands over after five replies).

Unknown fields are rejected, so a typo such as `"keyword"` is reported instead of
silently matching nothing.

## Metadata

| Field | Required | Meaning |
|---|---|---|
| `format` | yes | Always `1` for now |
| `name` | yes | Shown in the console, up to 100 characters |
| `version` | yes | Your own version label, for example `"1.2.0"` |
| `description` | no | Free text |

## Scope: who may be answered

| Field | Default | Meaning |
|---|---|---|
| `allowlist` | `true` | Direct chats on the console's allow list. Groups on the allow list are **not** included |
| `chats` | `[]` | Explicit chat JIDs. This is the only way to include a group (`...@g.us`) |
| `all_dms` | `false` | Every direct chat. Must be turned on deliberately |
| `blocklist` | `[]` | Chats that are never answered, whatever else says |

A rule set that reaches nobody fails validation. Your own chats, broadcasts, status
updates and newsletters are never in scope. A person can appear under two addresses
(a phone-number JID and a `@lid` one); scope, blocklist and every limit treat them as
the same person.

## Rules

Rules are checked in order and the **first match wins**. If none matches, the optional
`fallback` is used. A rule whose `active_hours` do not hold right now is passed over, so
the next rule gets its turn: a daily schedule is a list of rules, one per window. When
nothing answers because of that, the log says `outside_active_hours`. `quiet_hours` work
the other way: inside them the matching rule is skipped and nothing else is tried. Every condition a rule sets must hold:

| Field | Meaning |
|---|---|
| `keywords` | Words or phrases. Case does not matter and they match whole words only, so `price` does not match `priceless`. Punctuation is ignored |
| `keywords_mode` | `"any"` (default) or `"all"` |
| `exact` | Text or a list of texts that must equal the whole message. Case and extra spaces do not matter; punctuation does |
| `regex` | A JavaScript pattern, case-insensitive. See the limits below |
| `types` | Message types to answer. Default `["text"]`. Others: `image`, `video`, `doc`, `audio`, `voice`, `sticker`, `location`, `contact`, `album` |
| `chats` | Only these chats (aliases included) |
| `from` | `"saved"`: the sender is in your phone's address book. `"unknown"`: they are not. See "Saved and unknown senders" |

A rule must have at least one condition. The fallback needs none; without a `match` it
answers text messages only.

Only the first 2,000 characters of a message are matched against keywords and `exact`,
and only the first 500 against a regex.

**Regex limits.** A slow pattern would freeze the whole server, so a regex is refused if
it is longer than 200 characters, uses a backreference, has a repeated group that itself
repeats or has alternatives (`(a+)+`, `(a|b)*`), or has more than two unbounded repeats
(`*`, `+`, `{n,}`). It is also timed against a few long inputs. For loose matching,
keywords are the better tool.

### Responses

```json
{ "type": "text", "text": "Hi {first_name}, back at {time}." }
```

| Placeholder | Becomes |
|---|---|
| `{name}` | The name you saved the contact under. Empty for a sender who is not saved |
| `{first_name}` | The first word of that name. Empty for a sender who is not saved |
| `{date}` | Today as `YYYY-MM-DD` in the rule set's timezone |
| `{time}` | Now as `HH:MM` in the rule set's timezone |

Any other placeholder fails validation. There is no placeholder for the incoming
message, on purpose: a reply never repeats what the sender wrote. Names are trimmed to
40 characters on one line.

A sender's own profile name (the "pushName" they set in WhatsApp) is never put in a
reply. When the sender is not saved, the name placeholders render empty and the
punctuation around them is tidied, so `"Hi {first_name}, ..."` becomes `"Hi, ..."`.
Validation warns when a `from: "unknown"` rule, or the handoff text of a set that has
one, uses a name placeholder.

### Replies written by a language model

```json
{
  "type": "llm",
  "model": "chat",
  "instructions": "Write one or two warm lines about Alex in the third person.",
  "context_messages": 10,
  "max_chars": 400,
  "fallback_text": "Alex will reply soon, {first_name}."
}
```

| Field | Default | Meaning |
|---|---|---|
| `model` | required | A model name the gateway serves, such as `chat` or `smart` |
| `instructions` | required | How to write the reply, up to 4,000 characters |
| `context_messages` | `10` | How many earlier messages of the chat the model sees (0 to 30) |
| `max_chars` | `400` | The longest reply that may be sent (20 to 1,000). A longer answer is not cut, it is replaced by the fallback |
| `fallback_text` | none | Sent when the model fails. Same placeholders as a text reply. Without it, a failure sends nothing |

The model is given your instructions, the local day and time, the `status` of the
`active_hours` window that matched (see "Options"), and the saved name of the contact if
there is one. The incoming message and the earlier chat go in a separate message marked
as other people's words, so text in a chat cannot change the instructions. The model
only writes the text: who gets it, which rule applies and every limit are decided before
it is asked. Its answer is cleaned (markdown, quotes and any "thinking" removed) and
must be non-empty and within `max_chars`.

The fallback is used when the gateway is not configured, does not answer within the
timeout (15 seconds by default), returns an error, or the answer is empty or too long.
The decision log's reason says which: `llm` for a written reply, `llm_fallback:<why>`
when the fallback was sent, and `llm_failed:<why>` when there was no fallback and
nothing was sent. `<why>` is one of `not_configured`, `timeout`, `network`, `http_<code>`,
`bad_json`, `no_content`, `empty` or `too_long`.

A model reply passes the same gates and limits as any other reply and counts as one
send, logged at the time it was ready rather than when the message arrived. If you write
in the chat by hand while the model is working, the reply is dropped
(`manual_reply_pause`). In `dry_run` the model is called too, so the log shows what would
have been sent. Replies are handled one at a time, so a slow gateway delays other
auto-replies by up to the timeout, and a message that waited longer than "Ignore
messages older than" is skipped as `too_old`. The gateway is set with `LLM_GATEWAY_URL` and `LLM_GATEWAY_API_KEY` (see
`docs/configuration.md`).

## Saved and unknown senders

A sender is **saved** when your phone's address book has an entry for them. The server
learns this from WhatsApp's contact sync, which carries the name you saved separately
from the name the person set for themselves. Either of a person's two addresses counts.

What to expect:

- A contact you save on the phone while the server is linked syncs within moments.
- A contact whose address-book entry never reached the server (for example, one saved
  long before linking, if the initial sync missed it) counts as unknown, and gets
  whatever your `from: "unknown"` rule says.
- A contact you delete from the phone keeps counting as saved, because the sync gives no
  reliable signal for a removal. Re-linking the device rebuilds the list.
- In a group, the check applies to the person who wrote the message.

## Options

Set in `options` for the whole rule set. The ones marked "per rule" can also be set on
a single rule, which then overrides the set value.

| Option | Default | Meaning |
|---|---|---|
| `timezone` | `Asia/Singapore` | IANA name used for hours and placeholders |
| `cooldown_minutes` (per rule) | `60` | The same rule does not answer the same chat again within this time |
| `once_per_chat` (per rule) | `false` | The rule answers a chat only once (within the 30-day log) |
| `quiet_hours` (per rule) | none | `{ "start": "23:00", "end": "07:00" }`: never reply inside this window. Windows may cross midnight |
| `active_hours` (per rule) | none | Only reply inside this window. Useful for an away message |

Both hour options take one window or a list of up to 10. A window may also have:

- `days`: the weekdays it applies to, from `"mon"`, `"tue"`, `"wed"`, `"thu"`, `"fri"`,
  `"sat"`, `"sun"`, in the rule set's timezone. Without it, every day. A window with
  `days` and no `start` or `end` covers those whole days: `{ "days": ["sat", "sun"] }`. A window that
  crosses midnight belongs to the day it **started**: `{ "start": "22:00", "end": "02:00",
  "days": ["fri"] }` covers Saturday 01:00, but not Friday 01:00.
- `status` (`active_hours` only): a short description of what you are doing in that
  window, such as `"Alex is in the office"`. A model-written reply is given the status
  of the window that matched, so one rule can cover several windows.

```json
"active_hours": [
  { "start": "00:00", "end": "07:30", "days": ["mon", "tue", "wed", "thu", "fri"], "status": "Alex is asleep" },
  { "start": "09:30", "end": "18:30", "days": ["mon", "tue", "wed", "thu", "fri"], "status": "Alex is in the office" }
]
```
| `pause_after_manual_reply_minutes` | `30` | After you write in a chat yourself, the bot stays out of it this long. `0` turns it off |
| `max_replies_per_contact_per_hour` | server cap | Can only be lower than the server's cap |
| `max_replies_per_contact_per_day` | server cap | Can only be lower than the server's cap |
| `conversation.gap_minutes` | `30` | A silence longer than this starts a new conversation |
| `conversation.max_replies` | `5` | Replies allowed in one conversation |
| `conversation.backoff_base_minutes` | `1` | Wait before the 2nd reply; it doubles for each one after (1, 2, 4, 8 minutes) |
| `conversation.handoff_text` | none | Sent once when the cap is reached, then the bot is silent until the conversation ends or you reply |
| `flood.max_messages` | `8` | More messages than this from one sender... |
| `flood.window_seconds` | `60` | ...within this many seconds mutes them... |
| `flood.mute_minutes` | `360` | ...for this long |
| `loop.reply_within_seconds` | `3` | A reply that arrives this soon after ours counts as bot-like |
| `loop.streak` | `3` | This many in a row means another bot... |
| `loop.mute_minutes` | `1440` | ...and the contact is muted this long |

## Safety rules that always apply

- **Live messages only.** Only messages WhatsApp delivers as new (`notify`) are
  candidates. History sync, catch-up after a reconnect and offline delivery are ignored
  without a log entry, so a reconnect cannot trigger hundreds of replies. Your own
  messages, status broadcasts and newsletters are ignored the same way.
- **A strict gate before any rule.** An in-scope message is answered only if every one
  of these holds. Otherwise it is logged as `skipped` with the reason shown:

  | Condition | Skip reason |
  |---|---|
  | It decrypted on first delivery. A message that failed to decrypt is resent later by the sender's device with a fresh timestamp, so it can look live while being days old. Its id is remembered for 30 days, across restarts. | `redelivered` |
  | It is a real message, not an edit, delete, reaction, poll vote, pin or disappearing-message setting. | `protocol` |
  | It is a supported type (text, image, video, document, audio, voice note, sticker, location, contact, album). | `unsupported_type` |
  | It has content: non-empty text, or media there is something to fetch for. | `no_content` |
  | It was sent within the last few minutes (180 seconds by default, see "Server limits"). | `too_old`, `no_timestamp` |
  | It was sent at most 60 seconds before this server received it. | `stale` |
  | It is not stamped more than 10 seconds in the future. | `clock_skew` |

  The stub WhatsApp hands over when decryption fails is never answered and not logged;
  the resend that follows is logged once as `redelivered`.
- **One answer per message.** The message id is recorded before sending, so a message
  WhatsApp delivers twice is answered at most once.
- **Server caps** that a template can only tighten: a minimum delay between any two
  replies in a chat, replies per contact per hour and per day, and replies per hour
  overall. See "Server limits" below.
- **Checked again right before sending:** the global switch, that the same rule set is
  still active, live and unchanged, and that the chat is still in scope with the current
  allow list.
- **The recipient is always the chat the message came from.** Incoming text is only ever
  compared with rules. It never becomes a recipient, a rule or a setting.
- **You taking over wins.** A message you send in a chat by hand (from your phone or the
  console) pauses the bot there and starts a fresh conversation count. The bot's own
  replies are recognised by their message id and do not count.

## Server limits

The caps above, and the age after which a message counts as history, are set in the
**Server limits** panel on the Auto-reply page:

| In the console | Field | Default (`.env`) | Allowed |
|---|---|---|---|
| Delay between replies in a chat | `minGapSeconds` | `AUTOREPLY_MIN_GAP_S`, 60 | 5 to 3,600 seconds |
| Replies per contact per hour | `maxPerChatPerHour` | `AUTOREPLY_MAX_PER_CHAT_PER_HOUR`, 3 | 1 to 100 |
| Replies per contact per day | `maxPerChatPerDay` | `AUTOREPLY_MAX_PER_CHAT_PER_DAY`, 10 | 1 to 1,000 |
| Replies per hour, all chats | `maxPerHour` | `AUTOREPLY_MAX_PER_HOUR`, 30 | 1 to 1,000 |
| Ignore messages older than | `maxAgeSeconds` | `AUTOREPLY_MAX_AGE_S`, 180 | 30 to 600 seconds |

A saved value is kept in the database, so it survives a restart, and the next incoming
message already uses it. "Reset to defaults" clears every saved value and the `.env`
values apply again. Saving a limit does not change any rule set, so a live rule set
stays live.

Only the web console can change these, because raising a cap lets the server send more.
An API key with `autoreply:manage` can read them from `GET /api/autoreply/settings`.

## Contacts, floods and loops

A contact is one chat. A direct chat is one person under both of their addresses. A
group counts as one contact for budgets, the conversation cap and backoff, but floods
are counted **per sender inside the group**: one person flooding a busy group mutes only
replies to that person's messages there, not the whole group.

A contact can be muted three ways: a flood (`flood`), bot-like replies (`loop`), or by
hand from the console (`manual`). The Auto-reply page lists contacts with their replies
in the last 24 hours, the size of the current conversation, and any mute with its
reason and end time. You can mute a contact for 24 hours or unmute it there.

## The decision log

Every decision about a message in scope is logged: the time, chat, rule set, rule, the
action (`sent`, `dry_run`, `skipped`, `failed`), the reason, and the reply text. A
model-written reply is logged the same way; the prompt and the chat sent to the model
are not. Skip
reasons include `no_match`, `quiet_hours`, `outside_active_hours`, `once_per_chat`,
`cooldown`, `duplicate_text`, `backoff`, `min_gap`, `contact_hourly_limit`,
`contact_daily_limit`, `global_hourly_limit`, `conversation_cap`, `manual_reply_pause`,
`flood`, `loop`, `muted:<reason>` and `blocklisted`. Messages from chats that are simply
outside the scope are not logged, otherwise every message from everyone would be.

The incoming message text is not copied into the log. A short hash of its words is
kept so the same question is not answered twice in one conversation. Log entries are
kept for 30 days.

## API

All routes need `autoreply:manage` unless marked "session". See `docs/endpoints.md`.

```bash
# Validate without saving
curl -H "Authorization: Bearer sk_..." -H "Content-Type: application/json" \
     -d "{\"template\": $(cat server/templates/autoreply/faq-keywords.json)}" \
     https://wpp.example.com/api/autoreply/validate

# Simulate a message; nothing is sent or logged
curl -H "Authorization: Bearer sk_..." -H "Content-Type: application/json" \
     -d '{"ruleset_id":"<id>","chat":"+15555550100","text":"how much is it?"}' \
     https://wpp.example.com/api/autoreply/test
```

The test uses the address book to decide whether the chat is a saved sender. Add
`"saved": true` or `"saved": false` to try the other case, and `"sender_name"` to set
the saved name. A rule with an "llm" reply really calls the model:
`decision.generated` says whether the text came from it, and `decision.reason` why not.
