# A12 (真实日用host): the daily profile serves a LIVE Web host — measured

Gate A12 in `qualification/gates.json` is `NOT_RUN`, and `docs/OPERATIONS.md` says
the daily driver "is intended to be a long-lived Web host" and that "**that host
has not been qualified on this machine**". Every test in this repository drives the
graph IN-PROCESS; none of them starts the product a user would actually start.
That gap is the difference between "the code is correct" and 上手即用.

This note closes it with a measurement, not an argument.

## The measurement

Probe: `qualification/results/ROOT-round2/a12-probe.mjs`
Result: `qualification/results/ROOT-round2/a12-web-host.json`

```
$ node qualification/results/ROOT-round2/a12-probe.mjs
{
  "profile": "daily",
  "banner_printed": true,
  "port": 3080,
  "token_present_in_url": true,
  "still_running": true,
  "exit_code": null,
  "stderr_redacted": "",
  "port_listening": true,
  "http_status": 401,
  "http_status_bad_token": 401,
  "http_status_valid_token": 303,
  "auth_gate_established": true,
  "token_recorded_in_result": false
}
```

Each field is a separate fact:

| fact | value | why it matters |
|---|---|---|
| the host starts | `banner_printed: true` | it reaches the point of serving, not just parsing config |
| it is LONG-LIVED | `still_running: true`, `exit_code: null` | a daily driver must not be a one-shot; a one-shot wrapped in a shell loop would fake a second model loop |
| a port is listening | `port: 3080`, `port_listening: true` | the port is read from the host's OWN banner, not guessed (guessing produced an `EADDRINUSE` false positive twice in this project) |
| it answers HTTP | `http_status: 401` | it is a real server, not a process that printed a URL |
| **an auth gate exists** | `303` for the valid token vs `401` for none/bad | see below |
| the boot is CLEAN | `stderr_redacted: ""` | no warnings, no failed entries |

## Why three requests were needed

The first two arms are NOT sufficient, and saying so is the point:

- no token → `401`
- bad token → `401`

Those two together are equally consistent with **a server that rejects
everything**. So a third arm uses the host's own token: it returns **`303`** — a
redirect, i.e. the request was accepted. `401 ≠ 303` is what establishes that the
refusal is about the credential rather than about the server being broken.

## The token is used and never recorded

The host prints `dsh web: http://127.0.0.1:3080/?token=<secret>`. The probe reads
the token into memory to perform the third arm, and then:

- never writes it to the result (`token_recorded_in_result: false`);
- never logs it, never puts it in a command line;
- the artifact contains zero occurrences of `token=` — verified mechanically by
  `grep -c "token=" a12-web-host.json` → `0`.

Using a credential is not leaking it, and the standing constraint is about
printing. The probe asserts the absence rather than trusting its own code, because
a probe that echoed the URL would violate the constraint while looking like a
normal measurement.

## What this does NOT establish

- **No model turn.** The boot has no LLM (no live provider is authorized). The host
  serves; nothing here shows a model completing a task through it.
- **No browser interaction.** The HTTP facts are measured with a raw socket; the
  UI is not exercised, and the `303` is a redirect rather than a rendered page.
- **One machine, one port, one run.** Port 3080 was free; a busy port is not tested.
- **A12's gate entry is NOT edited by this note.** `qualification/gates.json` is a
  verdict ledger and writer S2 owns it. This records the measurement; whether A12
  becomes PASS is a verdict decision that belongs with the gate owner, and the
  evidence above is what that decision should cite.

## Reproduce

```
$ node qualification/results/ROOT-round2/a12-probe.mjs
# A12_HOME and A12_OUT override the home and the result path.
```
