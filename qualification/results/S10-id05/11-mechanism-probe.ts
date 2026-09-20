// S10 SCRATCH PROBE -- temporary, deleted immediately after one compile.
//
// Question 1: is the `attachments` port type ERASED to `any`? If so, the cast at
// data-plane.ts:720 suppresses nothing because there is nothing left to check.
// Question 2: does omitting the CONFIG argument to ctx.plugin compile (clause b)?
// Question 3: does dropping the cast on the PLUGIN argument compile (clause a)?
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as storageJsonPlugin from '@deepseek-ai/dsh-storage-json'
import * as storageDomainPlugin from '@deepseek-ai/dsh-storage-domain'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session'

// ---- Q1: the port type erasure ------------------------------------------
type AttachmentsPort = NonNullable<ReturnType<Context['get']>>
declare const port: AttachmentsPort
// Both of these compile ONLY if AttachmentsPort is `any`.
const q1a: { definitelyNotAField: number } = port
const q1b: number = port
export const q1 = [q1a, q1b]

// ---- Q2/Q3: the ctx.plugin clauses -------------------------------------
declare const ctx: Context
export async function q2(): Promise<void> {
  // clause (b): config OMITTED. Storage takes no config.
  await ctx.plugin(Storage)
  // clause (a): plugin cast dropped, config kept and correctly typed.
  await ctx.plugin(storageJsonPlugin, { root: '/tmp/x' })
  await ctx.plugin(storageDomainPlugin, { backend: 'json' })
}

// ---- the branded-value fixes --------------------------------------------
export const q3: FileAttachmentRef = {
  attachmentId: AttachmentId('cafebabe'),
  name: 'probe.png',
  bytes: 4,
}
export const q4 = SessionId('root-session')
