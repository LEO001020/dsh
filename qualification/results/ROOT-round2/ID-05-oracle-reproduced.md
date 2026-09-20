# ID-05's two named idioms, reproduced by measurement

The v2 oracle for ID-05 is unusually explicit: it NAMES two `as never` idioms so
the clause is decidable without a judgement call. Both were reproduced here so a
later reader does not have to re-derive them, and so a writer cannot argue the
oracle's reading.

## Clause (b) — the config-position cast MASKS a true diagnostic

Oracle text: *"`ctx.plugin(Storage, {} as never)` -- in CONFIG position the cast
MASKS a true diagnostic (`Argument of type '{}' is not assignable to parameter of
type 'undefined'`), and the argument should be OMITTED. A config-position
`as never` is NOT PASS."*

Reproduced, cast removed:

```
$ node D:/DSH/src/dsh-src/node_modules/typescript/bin/tsc --noEmit --ignoreConfig \
    --strict --module nodenext --moduleResolution nodenext --target es2022 id05probe.ts
id05probe.ts(4,27): error TS2345: Argument of type '{}' is not assignable to
parameter of type 'undefined'.
```

That is character-for-character the error the oracle names. And the prescribed
fix — OMIT the argument — compiles clean:

```
$ ... id05b.ts     # ctx.plugin(Storage)  with no second argument
(no output: compiles clean)
```

## Clause (a) — the PLUGIN-position cast is noise

Oracle text: *"the cast on the PLUGIN argument is noise, because
`ctx.plugin(plugin, cfg)` compiles clean"*.

Reproduced:

```
$ ... id05c.ts     # ctx.plugin(storageJsonPlugin, { root: '/tmp/x' })
(no output: compiles clean)
```

So a plugin-position `as never` can be removed without a replacement cast.

## The live sites, as found

`packages/dsh-daily-work/src/durability-runner.ts:37-39` — all three lines carry
config-position casts, and line 37 is the oracle's literal example:

```ts
await ctx.plugin(Storage, {} as never)
await ctx.plugin(storageJsonPlugin as never, { root } as never)
await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
```

`packages/dsh-daily-work/src/data-plane.ts:720` — `attachmentId: input.attachmentId
as never`. NOT a `ctx.plugin` config, so it is judged on its own merits rather than
by this clause.

## Reachability, because it changes how loud this should be

`durability-runner.ts` is NOT in the package's `exports`, and `recovery.ts` names
it only in a comment (`recovery.ts:208`). It IS emitted to
`lib/durability-runner.js`. So it is a hand-run CLI rather than a production
module: a clause-(b) violation in a test rig is still a violation of the oracle,
which does not scope itself to production, but it is not a product defect. Both
facts are stated so a reader does not have to guess which one applies.

## What is NOT established here

The recorded non-test count of 10 was NOT re-derived in this note. A grep for
`as never` over `src/*.ts` excluding `.test.ts` returns 48 lines, but most are the
English words "was never" matching the substring; the true cast count is writer
S10's to establish and report.
