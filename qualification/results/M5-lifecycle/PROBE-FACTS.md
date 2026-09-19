# M5 probe facts — what the real kernel does, measured

Two probe passes against a real `ipykernel` (Python 3.14.3, IPython 9.16.1,
ipykernel 7.3.0, jupyter_client 8.10.0, zmq 27.2.0) over `transport_encryption='required'`.
Rig: `kernel-broker.py` + `probe-lifecycle.py` + `probe-lifecycle2.py`.
Raw output: `lifecycle-probe.json`, `lifecycle-probe2.json`.

Every number below is a measurement. These are the facts `kernel-lifecycle.ts`
encodes; where a rule is not backed by one of them, the rule says so.

| # | Fact | Measurement | Consequence in the implementation |
|---|---|---|---|
| 1 | Late thread output carries the ORIGINATING cell's parent id | `belongsToSettledCell: true`, `text: "LATE-FROM-THREAD\n"`, parent == the settled cell's parent | Attribution is possible. Classify by parent id: `late` (known settled cell) vs `unattributed` (unknown parent). Never attach to the next cell. |
| 2 | The reader must drain IOPub after settle or late frames are never seen | The execute loop stops at reply+idle; an explicit `drain` was required to observe the late frame | The supervisor must not assume "cell settled" means "no more frames for it". |
| 3 | A stray `kernel_info_reply` is queued on the shell channel at every start | `foreign` frame, parent `..._1`, while the cell was `..._2`, in most sections | Filter by `parent_header.msg_id`; a foreign frame must not settle a cell. Confirms M11. |
| 4 | An output flood does not grow broker or kernel RSS | 256 MiB produced (`totalBytes: 268435468`), broker kept 65536, broker RSS 70.41 MB -> 70.84 MB, kernel RSS 79.75 MB -> 80.60 MB | The cap is enforced by the consumer, not by the kernel's generosity. Truncation is explicit (`truncated: true`) with both counts reported. |
| 5 | A 20 MB single MIME payload is delivered whole | `mimeSizes: {text/plain: 34, text/html: 20000041}`, broker RSS unchanged at 70.44 MB | MIME must be counted and capped separately from stdout; the frame is large even when the stream is small. |
| 6 | Control reaches the kernel fast, but the cell leaves the running state slowly under a flood | interrupt delivered in `0.002 s`; the cell settled `7.33 s` after the cancel was issued (cancel at 1.5 s) | Control latency has TWO numbers: dispatch latency (ms) and settle latency (seconds). RES-01 must report both, and the bound must cover the settle. |
| 7 | A CPU loop interrupts cleanly | `KeyboardInterrupt`, settled in 1.10 s / 1.64 s | The ordinary cancel path works. |
| 8 | **An await-suspended cell does NOT settle, and the kernel stays alive** | `timedOut: true` after 25.16 s; interrupt delivered in 0.001 s; second interrupt also delivered; `alive: true`; `busy: false` afterwards | Confirms M11. The bounded-grace -> `unknown` -> restart decision is mandatory, and it must be taken by the supervisor without awaiting the reply. |
| 9 | **A C-extension cell also does NOT settle** | `re.match(r'(a+)+$', ...)`: `timedOut: true` after 12.16 s, interrupt delivered in 0.002 s | There are at least two distinct non-settling classes: await-suspended and non-interruptible C code. Neither is recoverable in place. |
| 10 | The kernel is left with a pending interrupt that aborts the NEXT cell | after the wedge, the next cell settled `status: 'aborted'`, `executionCount: null`, no output; the cell after that ran normally (`ok`, output present) | "unknown but probably fine" is not a defensible post-grace state. The next cell is silently aborted, so continuing without a restart would corrupt results. Restart is required. |
| 11 | A killed kernel restarts and loses its namespace | `kill` -> `aliveAfter: false`; `restart` -> new pid; `'held' in dir()` printed `False` | Restart is a new epoch. Variables are gone and must be reported as `lost`. |
| 12 | Restart is repeatable | two consecutive restarts, both `error: null`, new pid each time | Epoch increments are unbounded, not one-shot. |
| 13 | A parked kernel's RSS is real and attributable to its live objects | baseline 79.50 MB -> **357.71 MB** holding one 256 MiB array -> 89.29 MB after `del` + `gc.collect()` | Parked kernels must be counted against the memory budget (RES-06). RSS is recoverable when the object is dropped, which is what makes eviction a real choice rather than a leak. |
| 14 | `np.zeros` measures lazily; `np.ones`/touched pages do not | first pass with `np.zeros((32,1024,1024))` showed 89.49 MB; second pass with `np.ones` showed 357.71 MB | A probe that measures RSS with lazily-mapped arrays under-reports. Recorded so the number is not re-derived wrongly. |
| 15 | stdin is disabled and fails fast | `StdinNotImplementedError` in 0.55 s | `allow_stdin=false` is enforced; a cell cannot wedge on a terminal. |
| 16 | **An old background thread can touch a NEW cell's memory** | cell `c-owner` left a thread that set `shared['value'] = 'MUTATED-BY-OLD-THREAD'`; cell `c-victim` (different id, later) printed `{'value': 'MUTATED-BY-OLD-THREAD', 'touched_by': 'cell-c-owner'}` | A cell id is an attribution/cancel/audit key and NOT an isolation boundary. No cell nonce is added and no isolation is claimed. Asserted as a test, not a comment. |
| 17 | Kernel stderr is empty in every non-settling case | `kernelStderr: {text: ""}` | A wedged kernel gives no diagnostic. Silence is not evidence of health. |

## What the probes do NOT establish

- Any behaviour of the DSH host, the DSH broker, or a DSH Session. No DSH process
  participated.
- Parquet/Arrow content validity. M5 validates magic bytes and size bounds only;
  it does not parse those formats.
- Whether an interrupt settles for every C extension. Two classes are measured as
  non-settling; that is evidence of existence, not a classification of all C code.
- Transport security beyond the connection file: `curve_publickey` present and
  the plaintext warning absent were checked in M11, not re-checked here.
