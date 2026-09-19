/**
 * The production launch path, exercised WITHOUT any test-installed port.
 *
 * WHY THIS TEST EXISTS. `host-plugin.ts` used to construct the service, register
 * the disposer and call `open()` — and never call `setLaunchPort`. Every
 * `submit` therefore recorded a task, moved it to `unknown` with
 * `uncertainty: 'no launch port installed'`, and launched nothing. The N=10
 * concurrency suite could not see this, because it installs its own port: a port
 * seam exists precisely so the top-up logic can be driven by a scripted adapter,
 * so every one of those tests passed while the composed product could not launch
 * a single child.
 *
 * That is the failure class this project keeps recording: an oracle weaker than
 * the scenario. The oracle here is "the service, given a port, tops up
 * correctly". The scenario is "a user runs the daily profile and the model's
 * submit starts a child". This file tests the second one by installing NOTHING
 * and letting the service bind the production port itself.
 *
 * The provider is still a scripted adapter, and that is deliberate rather than a
 * concession: the audit's own words are "a scripted adapter is not a second loop,
 * it is the provider". What is under test is that the PRODUCTION WIRE reaches the
 * real `ctx.subagents.startContinuable` seam — not that a paid model produces
 * good work, which needs an authorized budget and is recorded separately.
 */
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as spawnProvider from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkService } from './host.ts'

const roots: string[] = []

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-prodport-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
})

describe('the production launch port is installed by the product, not by a test', () => {
  it('reaches the real startContinuable seam with NO test-installed port', async () => {
    const root = tempRoot()
    const ctx = new Context()
    // The agents registry is provided by the production AgentLoop, whose
    // dependencies the official testkit mounts. Same shape the concurrency rig
    // uses, so this test differs from it only in NOT installing a port.
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    // Continuable children are durable, so they REQUIRE a session-persistence
    // backend. Omitting it fails the launch with "continuable subagents require
    // session persistence" -- which is what the first run of this test surfaced.
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
    await ctx.plugin(Storage)
    await ctx.plugin(storageJsonPlugin as never, { root: join(root, 'store') } as never)
    await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)

    // The real subagent runtime with the real spawn provider, exactly as the base
    // bundle mounts them. `maxActiveSubagents` is small so the test proves the
    // WIRE rather than the capacity, which the M6 suite owns.
    await ctx.plugin(SubagentRuntime, { maxActiveSubagents: 3, maxDepth: 1 })
    // The provider is itself a Cordis plugin: it registers itself under the name
    // in its config on apply. Mounting it is how the base bundle does it.
    await ctx.plugin(spawnProvider as never, { providerName: 'spawn' } as never)

    const service = new WorkService(ctx, {
      targetChildren: 2,
      maxDepth: 1,
      subagentProvider: 'spawn',
      budgetCeiling: 50,
      currency: 'USD',
      priceVersion: 'prodport-test',
      homeLockPath: join(root, 'home.lock'),
    })
    await service.open()

    try {
      // A real root Agent. The port binds to this exact object, so a session-id
      // string would not do.
      const handle = await ctx.agents.create({ sessionId: SessionId('sess-prodport-root') })
      const rootAgent = handle.agent
      const run = await service.createRun({
        runId: 'run-prodport',
        root: rootAgent,
        authorizationRef: 'auth-prodport',
        targetChildren: 1,
      })
      expect(run.phase).toBe('open')

      // NO setLaunchPort call anywhere in this test. If the production wire is
      // missing, drain takes the documented branch and this assertion fails with
      // reason 'no launch port installed' -- which is precisely the defect.
      const outcomes = await service.drain(
        'run-prodport',
        [{ taskId: 't1', childId: 'child-t1', prompt: 'say hello', reservedCost: 1 }],
        new AbortController().signal,
      )

      expect(outcomes).toHaveLength(1)
      expect(outcomes[0]?.reason).not.toBe('no launch port installed')
      // Admission, not execution: the contract quoted in launch-port.ts says a
      // resolved startContinuable means the child's inbox ACCEPTED the prompt.
      expect(outcomes[0]?.accepted).toBe(true)

      // The task must NOT be quarantined. `unknown` here would mean the record
      // admits it could not decide, which is the honest outcome for a failed
      // launch and the wrong outcome for a successful one.
      const record = service.getRun('run-prodport')
      expect(record?.tasks['t1']?.state).not.toBe('unknown')
      expect(record?.tasks['t1']?.childId).toBe('child-t1')
    } finally {
      await service.close()
      await ctx.fiber.dispose()
    }
  })

  it('still reports no-launch-port when the subagent runtime is genuinely absent', async () => {
    const root = tempRoot()
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
    await ctx.plugin(Storage)
    await ctx.plugin(storageJsonPlugin as never, { root: join(root, 'store') } as never)
    await ctx.plugin(storageDomainPlugin as never, { backend: 'json' } as never)
    // Deliberately NO SubagentRuntime: the port must not be inventable.

    const service = new WorkService(ctx, {
      targetChildren: 1,
      maxDepth: 1,
      subagentProvider: 'spawn',
      budgetCeiling: 50,
      currency: 'USD',
      priceVersion: 'prodport-test',
      homeLockPath: join(root, 'home.lock'),
    })
    await service.open()

    try {
      const handle = await ctx.agents.create({ sessionId: SessionId('sess-prodport-absent') })
      await service.createRun({
        runId: 'run-absent',
        root: handle.agent,
        authorizationRef: 'auth-absent',
        targetChildren: 1,
      })

      const outcomes = await service.drain(
        'run-absent',
        [{ taskId: 't1', childId: 'child-absent', prompt: 'x', reservedCost: 1 }],
        new AbortController().signal,
      )

      // With no runtime there is no port to bind, and the honest answer is the
      // documented one: record the task as `unknown` and hold the reservation.
      // Inventing a port here would fabricate a capability the host does not have.
      expect(outcomes[0]?.accepted).toBe(false)
      expect(outcomes[0]?.reason).toBe('no launch port installed')
      const record = service.getRun('run-absent')
      expect(record?.tasks['t1']?.state).toBe('unknown')
    } finally {
      await service.close()
      await ctx.fiber.dispose()
    }
  })
})
