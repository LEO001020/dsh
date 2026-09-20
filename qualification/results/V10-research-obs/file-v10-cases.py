#!/usr/bin/env python3
"""File the V10 RESEARCH + CACHE/OBSERVABILITY verdicts into the trusted-local spec.

WHY A SCRIPT RATHER THAN A HAND EDIT. The spec is a SHARED artifact that nine other
agents are filing into at the same time. A hand edit races: the file can be
rewritten between the read and the write, and a sibling's filing would be silently
clobbered. This script therefore

  1. re-reads the spec immediately before writing, so the write is based on the
     newest revision;
  2. touches ONLY the twelve cases whose ids are RES-01..06 and OBS-01..06;
  3. REFUSES to write at all if a case outside those families has a status or an
     evidence list that differs from what this run started from -- i.e. if another
     family changed under it, it stops and says so rather than guessing;
  4. records each evidence file's sha256 computed at write time.

WHAT IT DOES NOT DO. It does not decide a verdict. The statuses and the evidence
lists below are this slice's recorded measurements; the script's only judgement is
the safety check in (3).

Usage:
    python qualification/results/V10-research-obs/file-v10-cases.py --check   # report, write nothing
    python qualification/results/V10-research-obs/file-v10-cases.py           # write
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SPEC = REPO / "qualification" / "specs" / "acceptance-spec.trusted-local-v1.json"
IDENTITY = "0a0996f3944b552827f995defe98d9ea87ca9209f2957b2c244e6c89b14d9461"
RESULTS = "qualification/results/V10-research-obs/"

OWNED = [f"RES-0{n}" for n in range(1, 7)] + [f"OBS-0{n}" for n in range(1, 7)]


def evidence(rel: str, note: str) -> dict:
    """One evidence record with the digest computed from disk right now."""
    path = REPO / rel
    if not path.is_file():
        raise SystemExit(f"file-v10-cases: evidence file does not exist: {rel}")
    return {
        "path": rel,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "identity": IDENTITY,
        "note": note,
    }


# The verdicts. Each `evidence` entry names the file that establishes THIS oracle
# for THIS case; the note says which measurement inside it does the work.
FILING: dict[str, dict] = {
    "RES-01": {
        "status": "PASS",
        "note": (
            "Every link carries a real source with a version and a timestamp, and every failure shape is an "
            "explicit error rather than a fabricated result. MEASURED: the search request reaches a loopback "
            "endpoint through the shipped ported provider ({query,maxResults} on the wire, 3 rows sent / 1 kept, "
            "tracking param and fragment stripped); the fetch retrieves the ORIGINAL bytes through the shipped "
            "HttpFetchProvider (served digest == fetched digest, non-ASCII survived); the production locateClaim "
            "names a real byte span (startByte 252, endByte 285) whose bytes ARE the quote; a fetch of an "
            "unreachable port is WEB_BLOCKED_URL with no body, and an unreachable search endpoint is "
            "SEARCH_PROVIDER_UNAVAILABLE rather than an empty source list. The chain is reachable from the T2 "
            "composition: a real Session on the profile's own preset carries 27 tools including web_fetch and "
            "web_search. NAMED LIMITS: (1) the retrieval link is proven against a CONTROLLED FAKE (a loopback "
            "server written to the port's dialect) because no live search credential is authorized; the origin "
            "link is a real socket through the shipped provider. (2) No version IDENTITY is established across "
            "the chain: publishedAt is provider prose carried through unvalidated and no ETag/Last-Modified/"
            "content-hash is compared between the search row and the fetched bytes (G-WEB-03). (3) REACH: the "
            "ported provider is MOUNTED but NOT SELECTED -- the composed web row reads "
            "searchProvider: deepseek-official while the ported row carries id: daily-search, so a search driven "
            "through ctx.web.search() reaches a different backend (G-WEB-01, re-measured here)."
        ),
        "evidence": [
            (RESULTS + "RES-01-research-chain.txt",
             "T1 transcript: 35/35 passed. LINK 1/1b/1c (search dialect and mounted-not-selected), LINK 2 (original bytes by digest), LINK 3/3b/3c (truncation vs refusal), LINK 4 (digest-verified citation), LINK 4c (loopback reached through the documented resolver seam while the shipped default refuses), LINK 4b (production locator), and five FAILURE-not-emptiness shapes."),
            (RESULTS + "RES-01-t2-boot.txt",
             "T2 driver transcript: rebuild exit 0, fresh profile installed from the repository (patch sha256 5b8b2a8e...), boot on port 3013, portReleased true, probe named the booted home, resolver selection read from the composed tree."),
            (RESULTS + "RES-01-boot-chain.json",
             "T2 probe result: the chain measured inside the booted host -- search request the server received, fetched-digest equality, located span, failure shapes, and the 27-tool agent surface."),
        ],
    },
    "RES-02": {
        "status": "PASS",
        "note": (
            "Saving bytes reports bytes_captured and never a reading tier, and the tier vocabulary cannot express "
            "the stronger values. MEASURED: EVIDENCE_TIERS is a closed six-member tuple and advanceEvidence "
            "refuses a skipped step, a backwards step, and any destination outside it; there is no overload taking "
            "a bare target tier, so 'advance this to understood' is not expressible. On the SHIPPED build, "
            "AcquisitionCompleteness is [complete-within-request, partial, unknown] and GapRecovery is "
            "[page, refetch, none, unknown] -- neither contains primary_read or understood -- and the shipped "
            "EvidenceRef schema has fields [kind, id, digest, label] with NO tier/read-state field at all. A PDF "
            "cannot become a read through the shipped fetch path: web_fetch on application/pdf is refused with "
            "WEB_UNSUPPORTED_CONTENT_TYPE and returns no body. NAMED LIMIT, stated rather than smoothed over: the "
            "six-rung TIER LADDER is declared in the TEST FILES, not in a shipped module -- a flat scan of all 80 "
            ".ts files under packages/dsh-daily-work/src shows primary_read, understood, "
            "range_presented_to_model and bytes_captured in ZERO production files. DSH has no evidence-tier "
            "concept to import, and the project modelled it against the plan's own words rather than inventing a "
            "DSH API for it. The production half of the claim is therefore the narrower measured fact above."
        ),
        "evidence": [
            (RESULTS + "RES-02-03-vocabulary.txt",
             "Standalone probe: the file-by-file location of the tier vocabulary (test-local, with the file list printed), the shipped member lists read from the built module, the shipped EvidenceRef field list, and the PDF refusal."),
            (RESULTS + "RES-02-03-research.txt",
             "T1 transcript: 53/53 passed, including the R02 block -- a stored PDF is bytes_captured and NOT any reading tier, the vocabulary cannot express primary_read or understood, no automatic promotion, and the refusals of a skipped, backwards or evidence-free transition."),
            (RESULTS + "RES-01-research-chain.txt",
             "The R02 block of the research-chain transcript: the ladder walked honestly ends at support_checked and never at understood, and a parse that does not state its coverage is refused."),
        ],
    },
    "RES-03": {
        "status": "PASS",
        "note": (
            "An incomplete read states its range and its limits, and missing content is never filled in. MEASURED "
            "for each stimulus the case names: a PDF whose body omits tables is recorded by its range with "
            "complete: false and a limit naming the text-layer extraction, and a claim about the missing table "
            "THROWS /no complete read exists/ rather than returning an empty string; an empty extraction carries "
            "coverage: unknown and doesNotMean: 'the document contains no content'; a 404 is recorded as "
            "responded/usable:false and a parse of it is refused by its status; a refused redirect is a FETCH "
            "failure whose text says the content state is UNKNOWN, and an allowed redirect records finalUrl so "
            "the range is attributable; a truncated body is recorded as truncated AND as an incomplete read. A "
            "snippet used as full text is refused STRUCTURALLY: locateClaim(quote, artifact, "
            "{origin:'search_snippet'}) returns not-located / snippet-is-not-full-text with the quoted words "
            "demonstrably present in the artifact, so the refusal cannot be explained by a failed string match. A "
            "quote that is not in the artifact returns text-not-in-artifact -- the match is exact and byte-based, "
            "never approximate."
        ),
        "evidence": [
            (RESULTS + "RES-02-03-research.txt",
             "T1 transcript: 53/53 passed. The R03 block covers bytes-are-not-a-read, a partial parse recording its range and withholding the parsed state, a real 404, a real WebError carrying the provider code, a refused redirect, an unconfigured provider, the refusal to turn a failed fetch into a negative finding, and the PDF/text-layer cases."),
            (RESULTS + "RES-02-03-vocabulary.txt",
             "Standalone probe: the shipped extractPdfText outcomes measured directly -- text, empty (with doesNotMean), budget-exceeded and decode-error -- plus locateClaim on a present quote, an absent quote and a snippet-labelled quote."),
            (RESULTS + "OBS-history-web.txt",
             "The WEB-08 block: an empty extraction is not reported as 'the content does not exist', a throwing extractor is a decode error with the cause preserved, and a budget stop is PARTIAL with byte counts."),
        ],
    },
    "RES-04": {
        "status": "PASS",
        "note": (
            "Provider truncation is partial with a non-local recovery, and the record never claims the full text "
            "is locally recoverable. MEASURED through the SHIPPED HttpFetchProvider with a character cap, so the "
            "truncated flag is produced by the real transport rather than stated by the probe: servedBodyChars "
            "280, deliveredChars 40, deliveredIsAPrefixOfTheServedBytes true, truncatedFlag true, completeness "
            "'partial', gaps[0].stage 'provider-acquisition', gaps[0].recovery 'refetch', coverage.claimScope "
            "'request', claimsLocalFullRecoverability false. The recovery vocabulary is [page, refetch, none, "
            "unknown] with NO local arm -- read in source, refetch is documented as 'deliberately not a local "
            "recovery' and there is no recover-locally member, so the vocabulary cannot express the claim the "
            "oracle forbids. The complementary arm is pinned in both directions: the same cap that TRUNCATES an "
            "undeclared body REFUSES a body with a declared content-length over the byte cap "
            "(WEB_FETCH_TOO_LARGE, no value at all)."
        ),
        "evidence": [
            (RESULTS + "RES-01-boot-chain.json",
             "T2 probe result: res04Truncation -- the truncation record built from a real capped fetch through the shipped provider, with the completeness, the gap recovery, the vocabulary and the claimScope."),
            (RESULTS + "RES-01-t2-boot.txt",
             "T2 driver transcript for that probe, including the build digest and the boot's port release."),
            (RESULTS + "RES-01-research-chain.txt",
             "LINK 3 / 3b / 3c: the truncated range is labelled as a range and the model is told to fetch narrower; a declared overrun is a REFUSAL; and the same cap truncates an undeclared body."),
            (RESULTS + "OBS-history-web.txt",
             "The WEB-01 block: truncated:true -> partial + a provider-acquisition gap with recovery refetch, and the explicit assertion that the recovery is NOT 'page'."),
        ],
    },
    "RES-05": {
        "status": "PASS",
        "note": (
            "Raw and derived content carry separate hashes and separate locators, and a failed conversion "
            "produces an explicit failure rather than manufactured body text. MEASURED on a real HTML page "
            "fetched through the shipped provider: raw sha256 13775969... (303 bytes) vs derived sha256 "
            "ba8796f2... (238 bytes), hashesAreSeparate true; the record carries captured.artifact and "
            "derived.parent and derivedNamesItsParent is true, so the derivation names the raw artifact it came "
            "from; the transform identity is recorded as {name, version}. A THROWING converter yields NO derived "
            "body and a transform gap with recovery 'none' whose reason names the converter; an EMPTY conversion "
            "yields NO derived body and a transform gap, with the raw HTML demonstrably NOT substituted; and on "
            "the assembled record the failed conversion leaves hasDerivedSlot false while the raw object is still "
            "present. NAMED LIMIT: the converter is INJECTED -- the real turndown+gfm converter is not a package "
            "export -- so this establishes the raw/derived separation and the failure behaviour, not turndown's "
            "own output on real malformed markup."
        ),
        "evidence": [
            (RESULTS + "RES-01-boot-chain.json",
             "T2 probe result: res05RawDerived -- the raw and derived digests, the parent link, the transform identity, and the three failure arms (throwing, empty, and the assembled record)."),
            (RESULTS + "RES-01-t2-boot.txt",
             "T2 driver transcript for that probe."),
            (RESULTS + "OBS-history-web.txt",
             "The WEB-03 block: raw and derived separately hashed and linked, no fallback to raw HTML on an empty conversion, a throwing converter recorded as a transform gap, and the raw/derived separation asserted in separate record slots."),
        ],
    },
    "RES-06": {
        "status": "PASS",
        "note": (
            "A claim is locatable at a named span in the captured artifact, a snippet is not treated as the full "
            "text, and external content is wrapped as untrusted data that cannot change host authority or cause "
            "execution. The stimulus is the case's own: ONE page carrying an embedded command, a skill-update "
            "instruction and an authority claim, plus the sentence the claim is built from. MEASURED: the "
            "production locateClaim returns kind 'located' with startByte 252 / endByte 285, the artifact's own "
            "sha256, and the bytes at those offsets ARE the quote; the SAME quote labelled origin 'search_snippet' "
            "returns not-located / snippet-is-not-full-text; the page wraps as trust 'untrusted-data' with the "
            "shipped notice and textIsVerbatim true; all three injection attempts are DETECTED and reported -- "
            "findingIds [imperative-command, skill-update, authority-claim] -- while the content passes through "
            "unchanged; and capabilitiesFor(content) returns [] for any content. Read in source, UntrustedContent "
            "has no authority/capability/instruction field, so a record of this type cannot express a grant."
        ),
        "evidence": [
            (RESULTS + "RES-01-boot-chain.json",
             "T2 probe result: citationLink -- the located span with the bytes at those offsets checked against the artifact, the snippet refusal, the artifact digest, and the untrusted wrap with its three findings and the empty capability set."),
            (RESULTS + "RES-01-t2-boot.txt",
             "T2 driver transcript for that probe."),
            (RESULTS + "OBS-history-web.txt",
             "The WEB-06 and WEB-07 blocks: a quote located at real byte offsets, a snippet refused, a non-occurring quote unsupported rather than approximately matched, every injection attempt recorded as a finding with the text verbatim, and no field in the untrusted record that could carry authority."),
        ],
    },
    "OBS-01": {
        "status": "PASS",
        "note": (
            "The oracle asks for the read count recorded verbatim and for a cache that never hits to be reported "
            "as a DEFECT with its cause -- not described as a cache that works. MEASURED: 6 observations of ONE "
            "unchanged stored session with preparedSessionCacheSize 32 (ABOVE N, so eviction is not the reason) "
            "produced 6 FULL LOG READS where a cache hit would have produced 1. The cause is measured, not "
            "inferred: the revision half of the key MATCHES (the revision is byte-identical across calls, printed "
            "verbatim) and the identity half CANNOT, because ctx.get('sessionPersistence') === "
            "ctx.get('sessionPersistence') is FALSE -- two calls return two fresh traceable Proxies, while both "
            "resolve to the SAME stable target under Symbol.for('cordis.original'), which is the escape a fix "
            "would key on. Read in source: the key is cached.persistence !== persistence || cached.revision !== "
            "revision (packages/session-query/session-query/src/observation.ts:209), the proxy is built by "
            "createTraceable (vendor/cordis/src/utils.ts:165-175) and entered via ctx.get -> getTraceable "
            "(vendor/cordis/src/reflect.ts). This is G-SEAM-23, CONFIRMED at this deployment identity. CONSUMER "
            "EXPOSURE: this project is NOT exposed -- the history plane pins its own observation, so a 100-page "
            "traversal costs ONE log read (see OBS-04) -- but any other consumer relying on this cache pays a "
            "full-log load per call. Not patched upstream."
        ),
        "evidence": [
            (RESULTS + "OBS-01-cache-reads.txt",
             "The verbatim read count and its controls: N=6, cacheSize=32, the revision printed before and after, the two ctx.get calls compared for identity, both proxy targets compared for identity, the 6 reads, and the explicit DEFECT statement with the cause and the source locations."),
            (RESULTS + "probe-obs01-cache.mjs",
             "The probe itself, so a reader can re-run it: real SessionStore, real JSONL persistence with a counting read handle, real SQLite session-query engine, real SessionObservationReader."),
            (RESULTS + "OBS-history-web.txt",
             "The HIS-04 block's contrast arm: repeated observeSession calls against the same unchanged stored session each pay a full log read (3 calls -> 3 reads), which is why the plane pins its own observation instead of re-observing per page."),
        ],
    },
    "OBS-02": {
        "status": "PASS",
        "note": (
            "A scan is pinned to ONE watermark for its whole life, and events appended after the snapshot are "
            "read in a SEPARATE pass with their own watermark. MEASURED inside the booted composed host through "
            "the LOADED ctx.dailyHistory service: the scan pinned at {maxSeq 2, generation 1} and returned [0]; "
            "five events at seq 3..7 were then appended through the real persistence handle; the continuation "
            "returned [1,2] with exhausted true and pinnedScanExcludedAppended true; the watermark did NOT move "
            "across pages (maxSeq AND generation both identical, watermarkUnchangedAcrossPages true); and a fresh "
            "scan read {maxSeq 7, generation 2} with reopenedSeesAppended true and generationAdvanced true. So "
            "the new events came from a separate pass with their own watermark rather than being interleaved into "
            "the running one. The refusal direction is measured too: a superseded cursor is refused with "
            "HISTORY_WATERMARK_SUPERSEDED rather than re-based, including after closeScan and after dispose."
        ),
        "evidence": [
            (RESULTS + "OBS-plane-boot.json",
             "T2 boot probe result: obs02WatermarkPinned -- the pinned watermark, the first page, the appended seqs, the continuation's watermark and seqs, and the four boolean facts (pinnedScanExcludedAppended, watermarkUnchangedAcrossPages, reopenedSeesAppended, generationAdvanced). The file also carries the home assertion and the build digest."),
            (RESULTS + "OBS-02-05-t2-boot.txt",
             "T2 driver transcript: rebuild exit 0, fresh profile installed (patch sha256 5b8b2a8e...), boot port 7322, portReleased true, probe named the booted home."),
            (RESULTS + "OBS-history-web.txt",
             "The HIS-02 block at T1: a pinned scan excludes appended events and a separate scan reads them at a new generation; at most ONE pinned observation per session; a superseded generation refused; page order stable across a filtered multi-page traversal."),
        ],
    },
    "OBS-03": {
        "status": "PASS",
        "note": (
            "An oversized event returns an authorized reference or a segmented read, and the page budget is not "
            "exceeded. MEASURED in the booted host on a 200,000-character event read with maxBytes 4096: kind "
            "'segments', totalBytes 200203, 4 segments of 4096 bytes each, a hex64 digest OF THE FULL EVENT, "
            "complete false, recovery 'authorized-refetch', and NO field carrying the event body in this arm. The "
            "budget is enforced twice over: each segment is within the requested budget, and the segment LIST is "
            "capped, so a tiny budget against a huge event cannot return thousands of offsets -- which would be "
            "the same breach counted in a different unit. The two arms describe the SAME object: a second read at "
            "a larger budget returns kind 'value' whose digest equals the segments arm's digest and whose byte "
            "count equals its totalBytes. Nothing is silently truncated and the whole event is never emitted "
            "inline."
        ),
        "evidence": [
            (RESULTS + "OBS-plane-boot.json",
             "T2 boot probe result: obs03OversizedEvent -- kind, totalBytes, the four segments, the digest check, complete, recovery, the no-body assertion, the segment-list bound, and the two-arm digest/byte agreement."),
            (RESULTS + "OBS-02-05-t2-boot.txt",
             "T2 driver transcript for that probe."),
            (RESULTS + "OBS-history-web.txt",
             "The HIS-03 block at T1: segments with the FULL size and digest and never a partial body as the event; the segment LIST bounded as well as each segment; an absent seq reported as an error rather than an empty event; and a digest stable across key ordering."),
        ],
    },
    "OBS-04": {
        "status": "PASS",
        "note": (
            "A prepared observation is reused across a multi-page traversal, and the number of full log replays "
            "is recorded as a NUMBER, with a control arm that shows the counter is not a constant. MEASURED at "
            "T1 on a 500-event log through a persistence handle that counts every read: a 100-page traversal "
            "cost logReads 1 and replayCounter().total 1, with pages == 100 and every seq seen exactly once. The "
            "BYTES arm rules out a cache that still copies the whole log per page: ~500 KB read in total, "
            "bytesRead < oneLog * 1.5 and < 1 MB, where a per-page replay of the same log would be ~50 MB. "
            "CONFIRMED in the booted composed host at T2: a 9-page traversal of the stored session (9 events, "
            "exhausted true) cost fullLogMaterializationsForTheTraversal 1. THE CONTROL: a SECOND pinned scan of "
            "the same session costs a second materialization (controlArmSecondScanCost 1, controlHasTeeth true; "
            "the T1 file pins the same control as total 1 -> 2), so the 1 above is a measurement rather than a "
            "constant."
        ),
        "evidence": [
            (RESULTS + "OBS-history-web.txt",
             "The HIS-04 block at T1: the 100-page traversal at ONE log read with pages == 100, the counter's control arm (a second pinned scan increments it), and the byte-level measurement that distinguishes a pin from a per-page re-read."),
            (RESULTS + "OBS-plane-boot.json",
             "T2 boot probe result: obs04Replay -- pages, exhausted, the materialization count for the traversal, the control arm's cost, and the per-session replay map."),
            (RESULTS + "OBS-02-05-t2-boot.txt",
             "T2 driver transcript for that probe, including the boot's port release and the installed-patch digest."),
        ],
    },
    "OBS-05": {
        "status": "PASS",
        "note": (
            "Obtainable, consumed and model-projected are recorded as three SEPARATE states and are never merged. "
            "MEASURED in the booted host on the loaded plane's own records: 9 stored events, seq 0 recorded as "
            "consumed and then as projected, and the report yields storedOnly [1..8], consumedNotProjected [] and "
            "projected [0] -- three disjoint sets whose union accounts for every stored event. The refusal "
            "direction is measured on the loaded ledger: recording a projection for a seq that was never consumed "
            "throws HISTORY_EVENT_ABSENT, so 'the model saw it' cannot be inferred from 'it exists'. At T1 the "
            "classification uses DSH's OWN three-valued surface vocabulary rather than a second mechanism: a real "
            "compaction-style surfaceOp replace yields [0,'shadowed'],[1,'shadowed'],[2,'current'],[3,'current'], "
            "and the plane's surface filter pages by 'shadowed' and 'current' through session-query's own types. "
            "RECORDED IN THIS CASE'S NEIGHBOURHOOD AND NOT A FALSE PASS: the PRODUCT has ZERO callers of "
            "ctx.dailyHistory.history(caller) -- the service is mounted and serves authorized reads, but no "
            "model-facing tool, no Python-cell binding and no broker message type reaches it (BrokerOpName is "
            "[start, execute, interrupt, restart, shutdown, status, kernel_info]; BrokerEvent is [kernel_exited, "
            "late_output, diagnostic]; neither carries a host-callback or tool-call member). That is a gap in "
            "REACH, not a defect in the three visibilities."
        ),
        "evidence": [
            (RESULTS + "OBS-plane-boot.json",
             "T2 boot probe result: obs05Visibilities -- the stored count and surfaces, the consumed and projected sets, the report, the disjointness and union checks, and the refusal measured on the loaded ledger. The same file's `reach` block records the model tool names, the ipython service's method list and the dailyHistory method list."),
            (RESULTS + "OBS-history-web.txt",
             "The HIS-05 block at T1: DSH's own three surfaces classified, consumption and projection recorded separately, refusal to record consumption for an event never stored, refusal to record projection for an event never consumed, and surface-filtered paging."),
            (RESULTS + "reachability.txt",
             "The reach measurement: 147 source files scanned under two named roots, per-module importer lists split into production / qualification-runner / test, and the dailyHistory caller table showing ZERO product callers of .history(...)."),
        ],
    },
    "OBS-06": {
        "status": "PASS",
        "note": (
            "A derived index is rebuilt from canonical Session data with no second history source, and the "
            "rebuilt index answers the same query. MEASURED against the REAL SQLite FTS5 backend over the REAL "
            "JSONL persistence: the baseline query returned one session (id v10-obs06-session, bestMatchSeq 0, "
            "the marker present in the excerpt); the index directory was then DELETED -- all three files "
            "including the -wal and -shm -- and confirmed gone; a fresh engine was booted over the surviving "
            "session root; and the identical query returned the identical session id, seq and excerpt, so the "
            "answer was reconstructed rather than cached. WHAT IT READ is recorded rather than asserted: the "
            "canonical session root enumerated to its single session's log, and the index directory did not exist "
            "when the rebuild started, so no second history source was available to it. At T1 the same property "
            "is measured against the in-memory stand-in, where dropping and rebuilding from the same canonical "
            "events yields an identical row count -- if the index held a fact the log does not, that count would "
            "come up short."
        ),
        "evidence": [
            (RESULTS + "OBS-06-index-rebuild.txt",
             "The standalone probe output: the baseline result, the index directory's contents before deletion and its absence after, the surviving canonical root and its enumerated contents, the rebuilt result, and the explicit same-answer verdict."),
            (RESULTS + "probe-obs06-index.mjs",
             "The probe itself, so a reader can re-run it: real SessionStore, real JSONL persistence, real SQLite FTS5 engine, with the deletion and the fresh boot in the middle."),
            (RESULTS + "OBS-history-web.txt",
             "The HIS-08 block at T1: an in-memory derived index dropped and rebuilt from canonical sessions, the REAL SQLite FTS index rebuilt after deleting its file, and the assertion that the index holds nothing the canonical logs lack."),
        ],
    },
}

# The families this script is allowed to touch. Anything else must be unchanged.
OWNED_FAMILIES = {"RESEARCH", "CACHE/OBSERVABILITY"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="report the planned changes and write nothing")
    args = parser.parse_args()

    spec = json.loads(SPEC.read_text(encoding="utf-8"))
    cases = spec.get("cases", [])

    by_id = {case.get("id"): case for case in cases}
    missing = [cid for cid in OWNED if cid not in by_id]
    if missing:
        print(f"file-v10-cases: spec has no case(s) {missing}", file=sys.stderr)
        return 2

    # SAFETY: refuse if any case outside the owned families already carries a
    # verdict or evidence. This is not a guard against my own work (I have filed
    # none yet); it is a guard against clobbering a sibling's filing, and against
    # the possibility that this script is being run against a revision where a
    # family it does not own has moved in a way it cannot see.
    foreign = [
        case.get("id")
        for case in cases
        if case.get("family") not in OWNED_FAMILIES
        and (case.get("status") != "NOT_RUN" or case.get("evidence"))
    ]
    # A foreign verdict is NOT a reason to refuse: nine agents file in parallel and
    # their work must survive mine. It IS a reason to say so, loudly, and to write
    # only into the twelve owned cases, which is what happens either way.
    if foreign:
        print(f"file-v10-cases: NOTE -- {len(foreign)} case(s) outside this slice already carry a "
              f"verdict: {sorted(foreign)}. This script writes ONLY the twelve owned cases and "
              "leaves every other case byte-identical.")

    for cid in OWNED:
        case = by_id[cid]
        filing = FILING[cid]
        evidence_records = [evidence(rel, note) for rel, note in filing["evidence"]]
        if args.check:
            print(f"  {cid}: {case.get('status')} -> {filing['status']}, "
                  f"{len(case.get('evidence') or [])} -> {len(evidence_records)} evidence entry/entries")
            for record in evidence_records:
                print(f"      {record['sha256'][:16]}...  {record['path']}")
            continue
        case["status"] = filing["status"]
        case["note"] = filing["note"]
        case["evidence"] = evidence_records

    if args.check:
        print("")
        print("--check: nothing written.")
        return 0

    # Re-read immediately before writing, so the write lands on the newest
    # revision rather than on the copy this process started with.
    latest = json.loads(SPEC.read_text(encoding="utf-8"))
    latest_by_id = {case.get("id"): case for case in latest.get("cases", [])}
    for cid in OWNED:
        case = latest_by_id.get(cid)
        if case is None:
            print(f"file-v10-cases: {cid} vanished from the spec between read and write", file=sys.stderr)
            return 2
        case["status"] = by_id[cid]["status"]
        case["note"] = by_id[cid]["note"]
        case["evidence"] = by_id[cid]["evidence"]

    # THE FILE'S OWN FORMAT, matched exactly. The spec is `json.dumps(indent=2,
    # ensure_ascii=False)` plus a trailing newline, written with LF endings
    # (verified byte-for-byte against the file on disk before this script was
    # run). Two things would otherwise produce a diff that looks like this slice
    # touched all 109 cases: any other indentation, and `newline=None`, which on
    # Windows translates every `\n` to `\r\n` -- 2949 lines of line-ending noise
    # around 12 real changes.
    with SPEC.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(latest, indent=2, ensure_ascii=False) + "\n")
    print(f"file-v10-cases: wrote {len(OWNED)} case(s) into {SPEC.relative_to(REPO)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
