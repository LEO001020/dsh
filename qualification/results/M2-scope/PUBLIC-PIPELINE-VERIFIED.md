# The public tool pipeline already IS the PTC pipeline

The architecture asks for a public `ProgrammaticCallScope` so that a persistent
IPython cell and stock `run_code` share ONE execution implementation, and it
permits a minimal upstream patch to extract it. This note records why **no patch
is needed**, verified in source, because that decision changes the whole M2 shape.

## What the private symbol actually gates

`packages/core/tools/src/ptc.ts` reaches the runtime through a private symbol:

```ts
import { TOOL_RUNTIME_SCHEDULER } from './index.ts'      // ptc.ts:18
const scheduler = registry[TOOL_RUNTIME_SCHEDULER]        // ptc.ts:550
// ... scheduler.prepare(input) / scheduler.dispatch(exec) ...
```

That looks like the policy pipeline is behind a private seam. It is not. The
symbol exposes a **scheduling** interface, and the public `execute` path composes
the same four staged functions underneath it.

## The public path composes the identical stages

`packages/core/tools/src/index.ts:1349`:

```ts
return this.prepareExecution(exec, prepared => this.completeScheduledExecution(prepared))
```

and `index.ts:1352-1363`:

```ts
private async completeScheduledExecution(prepared: ScheduledToolPreparation): Promise<ToolExecutionResult> {
  switch (prepared.kind) {
    case 'dispatch': {
      const dispatched = await this.dispatchScheduledExecution(prepared.exec)
      return dispatched.kind === 'post-result'
        ? await this.finalizeScheduledExecution(prepared.exec, dispatched.result)
        : this.finishScheduledExecution(prepared.exec, dispatched.result)
    }
    ...
    return await this.finalizeScheduledExecution(prepared.exec, prepared.result)
    ...
    return this.finishScheduledExecution(prepared.exec, prepared.result)
  }
}
```

So `prepare` → `dispatch` → `finalize`/`finish` are the same functions whether the
call arrives through the public `execute` or through the private scheduler symbol.
**Policy, guard, approval, argument validation, post-execute, content finalization
and the `tools/result` notification are literally shared code.**

## What is genuinely different, and it is not policy

What `ptc.ts` adds on top is the **scheduling discipline**: one ordered driver
lane, a parallel pool bounded by `maxParallel`, an exclusive barrier held through
commit, and drain-on-settle. The architecture's BRG gates are about policy
equivalence and deadlock freedom, not about reproducing PTC's lane design:

- **BRG-01** (shared policy, no bypass) is satisfied *by construction* when the
  scope calls the public `execute`, because there is no second pipeline to diverge.
- **BRG-06** (no nested deadlock) is about the scope's OWN admission, so it is
  the scope's responsibility regardless of which seam it enters through.

## The one measured difference, stated rather than hidden

`ptc.ts` splits at the scheduler seam, so a slow `pre-execute` delays only the
NEXT start within its lane. A scope built on `execute()` cannot do that: each call
is one `execute()`, so a slow pre-execute occupies its own call rather than
deferring a sibling's start. That is a **scheduling** difference, not a policy
bypass, and M2 asserts it explicitly instead of leaving it implicit.

## Consequence

M2 builds the scope over the public surface: `registry.execute`,
`registry.executionMode`, `registry.schemas`. No `TOOL_RUNTIME_SCHEDULER` import,
no `Symbol.for` guess, no `as any`, no deep `src/` import, and **no upstream
patch** — which also means no patch digest to carry and no fork to maintain
against future upstream changes. The architecture's own framing supports this:
what is needed is "公共调用接口和持久执行面，不是第二个工具系统" — a public call
interface, not a second tool system.

## Status

Verified from source. The behavioural equivalence claim (same value, same
approval, same guard, native vs PTC vs scope) is M2's BRG-01 gate and is proven by
its test, not by this reading.
