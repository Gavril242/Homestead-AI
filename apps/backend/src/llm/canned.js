// In-character canned replies. Used when no LLM provider is reachable
// (no keys, all quotas blown, network down) so the demo never goes silent.
// They lean on real Afeela SHM context so the prototype still feels alive.

const CANNED = {
  conductor: [
    "Plan:\n1. Aria normalizes REQ-SHM-0142 with new latency budget [Aria]\n2. Delphi drafts ADR-017 amendment for the wake-up FSM [Delphi]\n3. Forge updates Shm_Swc.c against the revised interface [Forge]\n4. Vince retargets TC-SHM-212 to 120 ms [Vince]\n5. Ingo gates the next pipeline run on the new test [Ingo]",
    "Plan:\n1. Hunter reproduces B-9821 on bench-03 [Hunter]\n2. Forge proposes a minimal patch with diff [Forge]\n3. Vince re-runs the failing CAPL set [Vince]\n4. Scribe links the fix to REQ-SHM-0118 in the vault [Scribe]",
  ],
  aria: [
    "REQ-SHM-0142 — wake-up latency. AC: from CAN wake-up frame to first DiagSession=Programming response, the SHM shall reply ≤ 120 ms p99 on cold boot. Trace: TC-SHM-212. Source: customer review 2026-04-22.",
    "Filed B-9821 against REQ-SHM-0118: CAN-HS2 frame loss observed at 78% bus load on bench-03. Severity: major. Suggested owner: Hunter.",
  ],
  delphi: [
    "ADR-017 sketch:\n- Context: SHM diagnostic session FSM under-specified for Programming↔Default transitions during OTA.\n- Decision: introduce explicit `pendingProgramming` substate; gate it on tester present timeout (S3=5s).\n- Consequences: Shm_Swc.c +18 LOC, ARXML unchanged, TC-SHM-212 retargets, Confluence runbook needs an update.",
    "PlantUML for the new FSM:\n```plantuml\n@startuml\n[*] --> Default\nDefault --> Programming : 0x10 0x02 / S3=5s\nProgramming --> Default : timeout(S3) | 0x10 0x01\n@enduml\n```",
  ],
  forge: [
    "Proposed diff (Shm_Swc.c):\n```diff\n@@\n-static void Shm_HandleSessionRequest(uint8 sub) {\n-  Dcm_SetActiveSession(sub);\n+static Std_ReturnType Shm_HandleSessionRequest(uint8 sub) {\n+  if (sub == DCM_SESSION_PROG && !Shm_IsBootloaderReady()) return E_NOT_OK;\n+  Dcm_SetActiveSession(sub);\n+  Shm_StartTesterPresentTimeout();\n+  return E_OK;\n }\n```\nNext step: build with `make sim`, then `vince` re-runs TC-SHM-212. I will not declare success without that pass.",
    "Read 4 files (Shm_Swc.c, shm_dids.cin, TC-SHM-212.can, ADR-017.md), proposed 1 patch, 0 ran. Awaiting human review before applying — `git apply --check` is clean.",
  ],
  vince: [
    "TC-SHM-212 result: PASS — wake-up 94 ms (budget 120 ms). Evidence: bench-03 trace `runs/HIL-2026-04-25-bench3-212.asc`, CAN frame at T+94.31ms, screenshot in vault.",
    "TC-SHM-212 result: FAIL — wake-up 142 ms (budget 120 ms). Reproduces 3/3 times. Frames attached. Filing back to Hunter with the trace.",
  ],
  ingo: [
    "Pipeline #483 dispatched on barn-fleet-03. Stages: build → MISRA-C → unit → CAPL smoke → HIL soak. ETA 24 min. I'll bisect if anything turns red.",
    "MISRA-C check on PR #482 — clean. Coverage delta +0.4%. Confluence weekly KPI export queued for Fri 16:00.",
  ],
  hunter: [
    "Reproduced B-9821 on bench-03 at 78% load. Suspect commit 0x7a13f2 (CAN-HS2 buffer reorder). Minimal fix in tp.c +2 LOC. Will not declare fixed until TC-SHM-118 re-passes.",
    "Trace evidence: tp_rx_overflow at T+04:12.331, queue depth 32/32, dropped frame 0x7E8. Diff candidate posted; awaiting Vince's re-run.",
  ],
  scribe: [
    "Wrote ADR-017 to vault://decisions/ADR-017-diag-fsm.md. Forward links: components/Shm_Swc, tests/TC-SHM-212. Back links: reqs/REQ-SHM-0142.",
    "Confluence draft v0.5 release notes ready. 11 items, 3 breaking. Linked every breaking change to its REQ-* and PR.",
  ],
};

export function cannedReply({ agent, messages }) {
  const pool = CANNED[agent] || CANNED.conductor;
  // Pick deterministically off the message length so re-runs don't churn.
  const idx = Math.abs((messages?.[messages.length - 1]?.content?.length || 0)) % pool.length;
  return pool[idx];
}
