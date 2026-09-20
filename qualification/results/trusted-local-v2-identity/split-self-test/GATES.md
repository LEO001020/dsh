# trusted-local-v2 gate table

**QualificationContractIdentity:** `082d7f630a450752b1fab921a09875426eb560faf6ba9fdb2963ee7e9a392cb2`
**RuntimeDeploymentIdentity:** `ca78aae897cbbbd8dd3db38aefac82dff5200d67098b2c835c74076530903dd7`
**Acceptance definition digest:** `115aa092d0279c005d6f83d0412c1e00d374b60f803dd10f56eaba878ed664e1`

This table is a RESULT. It is not an identity input, and filing it does not move either identity above. That is the property the v2 definition/result split exists for, and `file-result.py` proves it by recomputing both identities before and after the write.

## Verdict counts

- `NOT_RUN`: **0**
- `PASS`: **1**
- `FAIL`: **0**
- `NOT_CLAIMED`: **1**
- `BLOCKED_EXTERNAL`: **0**

Cases in the definition: **110**

## Rows

| case | verdict | evidence | reused | basis |
|---|---|---|---|---|
| ID-02 | PASS | 1 | 0 |  |
| REC-09 | NOT_CLAIMED | 0 | 0 | SELF-TEST ROW, not a filed verdict: it exists to exercise the NOT_CLAIMED validation path. R9 owns the real topology decision. |
