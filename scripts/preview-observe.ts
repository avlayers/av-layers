export interface PointerTrace { epochMs: number; playhead: number; scene: number | null; sceneCount: number }
export interface PointerAction { kind: 'day-switch' | 'scrub' | 'gesture-end'; requested: number; before: PointerTrace; after: PointerTrace }
export interface PointerInput { index: number; targetFrame: string; inputEpochMs: number; outcome: string }
export interface SceneEvent { index: number; frame: string; epochMs: number }

export function correlatePointerActions<T extends PointerInput>(actions: PointerAction[], inputs: T[], commits: SceneEvent[], endEpochMs: number, frames: string[]) {
  return actions.map(action => {
    const observations = inputs.filter(input => input.inputEpochMs >= action.before.epochMs && input.inputEpochMs <= action.after.epochMs);
    const chosen = (action.kind === 'day-switch' ? observations.at(-1) : observations.findLast(input => input.index === action.requested)) ?? null;
    const next = chosen ? inputs.find(input => input.inputEpochMs > chosen.inputEpochMs) : undefined;
    const until = next?.inputEpochMs ?? endEpochMs;
    const selectionCommits = chosen ? commits.filter(commit => commit.epochMs >= chosen.inputEpochMs && commit.epochMs < until) : [];
    const delivered = chosen ? selectionCommits.filter(commit => commit.index === chosen.index && commit.frame === chosen.targetFrame) : [];
    const staleCommits = selectionCommits.filter(commit => !delivered.includes(commit));
    const status = action.kind === 'scrub' && action.after.playhead !== action.requested ? 'diverged' : delivered.length ? 'delivered' : !chosen && action.before.playhead === action.requested && action.after.scene === action.requested ? 'already-selected' : chosen?.outcome === 'superseded' ? 'superseded' : chosen?.outcome === 'timeout' ? 'timeout' : 'not-delivered';
    return { ...action, requestedFrame: frames[action.requested], observations, chosen, selectionUntilEpochMs: chosen ? until : null, delivered, staleCommits, status };
  });
}

export function measureWindCall<T>(kind: 'grid' | 'sampler', cached: boolean | null, call: () => T, built: () => boolean | null, record: (name: string, ms: number) => void, now = () => performance.now()): T {
  const start = now(), state = cached === null ? 'unknown' : cached ? 'cached' : 'uncached';
  let result: T;
  try { result = call(); }
  catch (error) { record(`wind-${kind}-${state}-failed`, now() - start); throw error; }
  const elapsed = now() - start;
  record(`wind-${kind}-${state}-${result == null ? 'null' : 'success'}`, elapsed);
  if (!cached && cached !== null && result != null && built() === true) record(`wind-${kind}-build`, elapsed);
  return result;
}
