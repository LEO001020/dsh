# Does the plan require a sandbox for DSH? YES — and this machine can actually provide one

**Status: the requirement is real and mandatory; the implementation does not exist;
the substrate to build it is present and was measured working.**

## 1. What the plan actually requires

The pro model's package states the requirement in two places, and it is not
optional language.

**`delivery/ARCHITECTURE.zh-CN.md` §13 "安全与执行环境：选择一条正式生产路径":**

> **正式路径：trusted DSH host + 第一方SSH execution world + 专用Linux执行VM。**
> Windows/macOS仍可用原Web UI/host；不把当前Windows限制token当作可靠private
> read/egress边界。

> 该VM仅容纳用户明确投送的当前项目和受控运行环境。native FS/subprocess/sandbox
> 解析在此execution world；不得混用host FS读取remote cwd。模型密钥、私人history、
> 整个HOME、host管理socket不在执行域。worker到host管理UI、cloud metadata、
> 局域网/private addresses默认不可达。

> 每kernel的OS隔离：只读运行环境与授权source mounts，可写session scratch，
> 私有pid/proc/IPC，**无任意网络**，CPU/memory/pids/file limits；不把整个VM根目录
> 只读bind给kernel便声称私密性。

**`delivery/MASTER_EXECUTION_PLAN.zh-CN.md` M1, items 5 and 7:**

> 5. 配置第一方SSH native FS/subprocess/sandbox provider一致指向专用Linux VM。
>    核对helper bundle/source hash、Node和cwd；稳定连接共享，不每tool新建ssh。
> 7. **占位VM、无法建网络隔离或只能unsandboxed运行，均不得晋级为safe daily。**

So: yes. A dedicated Linux execution world reached over DSH's own SSH providers is
the **formal production path**, and item 7 makes it a **promotion blocker** — a
placeholder VM, or one that cannot do network isolation, or one that can only run
unsandboxed, must not be promoted.

## 2. Why it is required: the measured gap it closes

This project measured that the Windows sandbox seam **cannot** express the
requirement, at every level (recorded as G-SEAM-12/24, gate SEC-01/SEC-03 FAIL):

- `SandboxMode`'s own doc: *"Network and process visibility are outside this
  vocabulary"* (`packages/sandbox/sandbox/src/index.ts:24-27`).
- The Windows backend's own header: *"writes are restricted; reads, network, and
  process visibility are NOT (WRITE_RESTRICTED intersects only write accesses)"*.
- A confined child **reads** a canary outside the workspace root verbatim, under
  both `read-only` and `workspace-write`, and completes a network round trip.
- Four candidate levers were probed; **none** restricts a read. `runnerCommand` —
  the one real public seam — only swaps *which* file-effect confiner applies the
  same profile.

The plan's own words match the measurement: *"不把当前Windows限制token当作可靠
private read/egress边界"* — do not treat the current Windows restriction token as a
reliable private-read/egress boundary. **So the plan does not ask for a Windows
sandbox fix. It asks for a different execution world.**

## 3. The DSH seam already exists — first party

The pinned checkout ships the four providers the plan names. Nothing needs to be
invented:

| Package | Description |
|---|---|
| `@deepseek-ai/dsh-ssh` | Shared OpenSSH connection and versioned POSIX remote helper |
| `@deepseek-ai/dsh-fs-ssh` | Filesystem provider over the shared POSIX SSH helper |
| `@deepseek-ai/dsh-sandbox-ssh` | Remote POSIX sandbox argv provider over the shared SSH helper |
| `@deepseek-ai/dsh-subprocess-ssh` | Subprocess and terminal provider over the shared POSIX SSH helper |

**No shipped bundle patch mounts any of them** — `grep -l ssh packages/bundle/*/cordis.patch.yml`
returns nothing. So this is an unmounted capability, which is why gate **DEP-04 is
`NOT_RUN`** ("No SSH execution world exists on this deployment").

## 4. The substrate to build it is present, and was measured working

`MASTER_EXECUTION_PLAN` item 7 requires network isolation. The question is whether
a Linux execution world is actually available on this machine. **Measured — it is.**

```
$ wsl.exe -d Ubuntu -- bash -lc "uname -r; bwrap --version; sysctl -n user.max_user_namespaces"
6.18.33.2-microsoft-standard-WSL2
bubblewrap 0.11.1
144271
```

**Network isolation works** (`--unshare-net`):

```
$ bwrap --ro-bind / / --dev /dev --proc /proc --unshare-pid --unshare-net \
    --die-with-parent /usr/bin/bash -c 'timeout 5 bash -c "echo > /dev/tcp/1.1.1.1/80"'
bash: connect: Network is unreachable
bash: line 1: /dev/tcp/1.1.1.1/80: Network is unreachable
NET_BLOCKED
```

**Read isolation works** — and this is the property the Windows seam cannot
express. An unbound path does not merely deny access; it **does not exist inside
the sandbox**:

```
# canary placed outside the workspace
$ echo CANARY-SECRET > /tmp/secret-test/creds.txt

# control: readable WITHOUT bwrap
$ cat /tmp/secret-test/creds.txt
CANARY-SECRET

# inside bwrap, /tmp is a tmpfs and the canary path is absent
$ bwrap --ro-bind /usr /usr --ro-bind /lib /lib --ro-bind /lib64 /lib64 \
    --ro-bind /bin /bin --ro-bind /etc /etc --dev /dev --proc /proc --tmpfs /tmp \
    --unshare-pid --unshare-net --die-with-parent \
    /usr/bin/bash -c 'cat /tmp/secret-test/creds.txt 2>&1 || echo READ_BLOCKED'
cat: /tmp/secret-test/creds.txt: No such file or directory
READ_BLOCKED
```

Raw transcript: `MEASURED.txt` in this directory.

## 5. What this does and does not establish

**Establishes:**
- The plan mandates a sandboxed execution world, and makes it a promotion blocker.
- DSH's first-party SSH providers for exactly this exist in the pinned checkout.
- This machine has a Linux kernel with working user namespaces and a working
  `bwrap` that provides **both** the network isolation and the read isolation the
  Windows seam cannot.

**Does NOT establish:**
- That the SSH execution world is **built**. It is not. `dsh-sandbox-ssh` is not
  mounted, no SSH target is configured, and no DSH tool resolves into a remote
  world. DEP-04 remains `NOT_RUN`.
- That WSL is an acceptable **production** execution world. WSL2 is a VM with a
  shared kernel interface and host-integration mounts (`/mnt/c`, and by default
  `automount` of Windows drives). Using it as the formal path needs its own
  threat model: which host paths are reachable from inside, whether the
  distribution's `bwrap` can be trusted as the confiner, and whether the SSH
  helper's `Node` and `cwd` requirements are satisfied. The plan itself demands
  this: item 5 says *"核对helper bundle/source hash、Node和cwd"*.
- That WSL satisfies the plan's **per-kernel** isolation paragraph. That paragraph
  asks for per-kernel OS isolation (private pid/proc/IPC, no arbitrary network,
  CPU/memory/pids/file limits) and explicitly warns *"不把整个VM根目录只读bind给
  kernel便声称私密性"* — do not read-only-bind the whole VM root to the kernel and
  call it private. A single bwrap profile for a whole VM is exactly what that
  sentence forbids.
- Anything about the plan's `history`/`artifact` per-read authorization, which the
  architecture keeps on the host regardless of world.

## 6. The honest summary

**The plan requires a sandbox, this project has not built it, and this machine
can host one.** Those are three separate facts and all three are measured.

The gap is not a missing mechanism — DSH ships the four providers — and not a
missing substrate — WSL has a working kernel and a working `bwrap` that closes
exactly the read and egress holes the Windows seam leaves open. The gap is that
**nobody has mounted the providers and pointed them at a Linux world**, which is
`MASTER_EXECUTION_PLAN` M1 items 5–6, and which `DEP-04` records as `NOT_RUN`.

Until that is done, `SEC-01` and `SEC-03` stay **FAIL**, and the plan's item 7
forbids promotion. That is consistent with the recorded promotion verdict:
`NOT_READY`.
