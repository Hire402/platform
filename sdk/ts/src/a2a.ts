/**
 * A2A-semantics task lifecycle over HTTP (Phase 1). The researcher agent
 * exposes a minimal task lifecycle (submit → working → submitted →
 * released → solvent); full A2A 1.0 SDK conformance is a Phase 2 item
 * (roadmap §2, docs/spec-pins.md).
 */
export interface TaskPayload {
  escrowId: string; // stringified escrow id
  milestoneIndex: number;
  buyer: `0x${string}`;
  description: string;
}

export interface TaskStatus {
  taskId: string;
  status: 'working' | 'submitted' | 'released' | 'solvent' | 'rejected';
  escrowId?: string;
  detail?: string;
  startTx?: string;
  submitTx?: string;
  claimTx?: string;
  inferenceTx?: string;
  attestation?: string;
  result?: string;
  error?: string;
}

export async function postTask(base: string, payload: TaskPayload): Promise<TaskStatus> {
  const res = await fetch(`${base}/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`postTask failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as TaskStatus;
}

export async function getTask(base: string, taskId: string): Promise<TaskStatus> {
  const res = await fetch(`${base}/tasks/${taskId}`);
  if (!res.ok) throw new Error(`getTask failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as TaskStatus;
}
