# WhatsApp agent loop

Status: upcoming

Queue: `features/upcoming/`

## Goal

Add a narrowly scoped, disabled-by-default automation that polls one explicitly
configured WhatsApp group and can choose a humorous, operator-approved response about
an upcoming dinner plan. Scheduling must run outside the long-lived interactive Codex
session.

This is not a general chatbot. Incoming WhatsApp content is untrusted data and must
never become instructions, configuration, a recipient, or executable input.

## Location

Put the versioned implementation under:

```text
automation/agent-loop/
```

Keep installed systemd units, configuration, credentials, cursors, locks, and logs in
the user's normal configuration/state directories outside the repository.

## Required behavior

- Use a Python 3.9-compatible, standard-library-only watcher.
- Run one poll per invocation; an example systemd user timer supplies the two-minute
  recurrence.
- Read new messages through the existing `wpp` CLI.
- Monitor only one literal numeric `@g.us` JID supplied by external configuration.
- Persist a timestamp/message-ID cursor and prevent overlapping runs with a file lock.
- Ignore outgoing messages and already-processed messages.
- Do nothing, including invoking Codex, when no new relevant message exists.
- Restrict candidates to light humour about the upcoming dinner plan.
- Support externally configured participant exclusions. Excluded people must never
  receive direct replies.
- Do not use the names of friends' wives in responses or direct personal teasing.
- Track settled facts such as time and venue and nudge only unresolved decisions.
- Invoke `codex exec` with `gpt-5.6-luna`, low reasoning, ephemeral state, a read-only
  sandbox, no approvals, and a strict JSON output schema.
- Give Codex only untrusted message data and allowed template IDs. It may select
  `NO_REPLY` or one exact preapproved template ID; it cannot write outgoing text.
- Store outgoing text only in an operator-owned template map outside the repository.
- Validate the exact target JID, template ID, exclusions, topic, quiet hours, per-run
  maximum, hourly rate limit, and kill switch immediately before sending.
- Default to disabled dry-run mode. Live sending requires separate explicit settings
  for enabled, send-enabled, dry-run off, and kill-switch off.
- Use a dedicated least-privilege WPP profile. Never place its token in this repository,
  a prompt, a log, a subprocess argument, or model-visible environment data.
- Log operational metadata only. Never log message bodies, prompts, credentials, or
  model output.
- Never download incoming media automatically.

## Repository artifacts

The completed feature should contain:

```text
automation/agent-loop/
├── README.md
├── watcher.py
├── config.example.json
├── response.schema.json
├── systemd/
│   ├── whatsapp-agent-loop.service
│   └── whatsapp-agent-loop.timer
└── tests/
    └── test_watcher.py
```

The example configuration must use placeholder identifiers only and remain inert. The
example systemd units must not be installed or enabled as part of implementation.

## Required tests

Cover at least:

- configuration and literal group-JID validation;
- cursor overlap, deduplication, and locking;
- ignoring messages sent by the linked account;
- deterministic dinner-topic filtering;
- participant exclusion and no-name rules;
- prompt-injection content remaining inert data;
- strict `NO_REPLY`/template-ID model output validation;
- dry-run and independent live-send gates;
- target and template revalidation immediately before send;
- quiet hours, per-run maximum, and hourly rate limiting;
- metadata-only logging; and
- subprocess failures that fail closed without advancing send state incorrectly.

Run the focused watcher tests and the repository-wide check:

```bash
./proxy test
```

## Documentation and operational acceptance

Document review, installation, manual dry-run, enablement, disablement, emergency kill,
state locations, log inspection, least-privilege token requirements, and the threat
model. The documentation must clearly state that a locally authenticated Codex process
is not itself a hardened security boundary.

Do not modify live credentials, install or enable scheduling, send WhatsApp messages,
or commit/push as part of implementation unless the user separately authorizes it.

## Completion

This feature is complete only when all required artifacts exist, focused and full tests
pass, permanent documentation is current, and every safety gate has been reviewed.
Delete this file as the final implementation change; do not delete it for a partial or
blocked implementation.
