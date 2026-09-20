# trusted-local-v2 gate table

**QualificationContractIdentity:** `88834ae45ad7fd561f3f371fce693212cc4cdfaa6fa23d80d8a78e3ebaef2a1a`
**RuntimeDeploymentIdentity:** `8efdbd93550a92027c17f7c14e9d62782a28127b10714cb3fc02955b8578f656`
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
