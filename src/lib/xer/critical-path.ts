/**
 * DCMA check 12, the critical path test: add a large delay to the first unfinished critical activity
 * and see whether it reaches the project finish.
 *
 * Rather than rescheduling, the delay is traced through the logic. With a delay far larger than any
 * float, every activity the delay can reach is pushed by it, so "does the finish move by the delay"
 * is the same question as "is there a path from the delayed activity to the finish that nothing
 * stops". This needs no calendar arithmetic, so it can't disagree with P6 over dates.
 *
 * Each activity is two points, its start and its finish. The delay is added to the duration, so it
 * starts at the finish. Links carry it by type: finish-to-start and finish-to-finish from a finish,
 * start-to-start and start-to-finish from a start; a start always pushes its own finish. A finished
 * activity or one with a mandatory constraint can't move, so the delay stops there.
 *
 * Critical means on the path that drives the finish: total float within the project's critical
 * margin (PROJECT.critical_drtn_hr_cnt) of the finish's own float. P6's own flags don't serve: its
 * "critical" threshold can leave out the finish when the finish has float against a deadline, and
 * TASK.driving_path_flag is only as fresh as the last longest-path run.
 */

export type PathActivity = {
  taskId: string;
  type: string;
  status: string;
  earlyStart: string | null;
  earlyFinish: string | null;
  totalFloatHours: number | null;
  /** Has a mandatory start or finish, so logic can't move it. */
  mandatory: boolean;
  line: number;
};

export type PathLink = { pred: string; succ: string; type: string };

export type CriticalPathTest =
  | { skipped: string }
  | {
      skipped?: undefined;
      passed: boolean;
      /** The activity the delay was added to. */
      start: string;
      /** The project's finish activity. */
      finish: string;
      /** On a pass: the activities from the start to the finish, each with the link that pushed it. */
      path: { taskId: string; via: string | null; from: string | null }[];
      /** On a fail: where the delay stopped, and why. */
      stops: { taskId: string; reason: string }[];
    };

const SKIPPED_TYPES = new Set(["TT_LOE", "TT_WBS"]);
const MAX_STOPS = 200;

type Point = `${"S" | "F"}:${string}`;

/** The project's finish: the unfinished activity with the latest early finish, a finish milestone first. */
export function projectFinish(activities: Map<string, PathActivity>): PathActivity | undefined {
  return [...activities.values()]
    .filter(a => a.status !== "TK_Complete" && !SKIPPED_TYPES.has(a.type) && a.earlyFinish)
    .sort(
      (a, b) =>
        (b.earlyFinish ?? "").localeCompare(a.earlyFinish ?? "") ||
        Number(b.type === "TT_FinMile") - Number(a.type === "TT_FinMile") ||
        a.line - b.line
    )[0];
}

export function criticalPathTest(
  activities: Map<string, PathActivity>,
  links: PathLink[],
  /** How far from the finish's float an activity can be and still count as critical, in hours. */
  criticalMarginHours: number
): CriticalPathTest {
  const open = [...activities.values()].filter(a => a.status !== "TK_Complete" && !SKIPPED_TYPES.has(a.type));
  const byDate = (a: string | null, b: string | null) => (a ?? "").localeCompare(b ?? "");

  const finish = projectFinish(activities);
  if (!finish) return { skipped: "No unfinished activity has a forecast finish." };

  const finishFloat = finish.totalFloatHours;
  if (finishFloat === null) return { skipped: "The finish activity has no total float to compare against." };
  const margin = Math.max(criticalMarginHours, 1);
  const isCritical = (a: PathActivity) =>
    a.totalFloatHours !== null && Math.abs(a.totalFloatHours - finishFloat) <= margin;
  const start = open
    .filter(isCritical)
    .filter(a => a.taskId !== finish.taskId && a.earlyStart)
    .sort((a, b) => byDate(a.earlyStart, b.earlyStart) || a.line - b.line)[0];
  if (!start) return { skipped: "No unfinished critical activity comes before the finish." };

  const next = new Map<Point, { to: Point; type: string; from: string }[]>();
  const edge = (from: Point, to: Point, type: string, pred: string) => {
    if (!next.has(from)) next.set(from, []);
    next.get(from)!.push({ to, type, from: pred });
  };
  for (const l of links) {
    if (!activities.has(l.pred) || !activities.has(l.succ)) continue;
    const [fromEnd, toEnd] =
      l.type === "PR_SS" ? ["S", "S"] : l.type === "PR_FF" ? ["F", "F"] : l.type === "PR_SF" ? ["S", "F"] : ["F", "S"];
    edge(`${fromEnd}:${l.pred}` as Point, `${toEnd}:${l.succ}` as Point, l.type || "PR_FS", l.pred);
  }

  const blocked = (a: PathActivity) =>
    a.status === "TK_Complete"
      ? "Already finished, so it can't move"
      : a.mandatory
        ? "Mandatory constraint holds it in place"
        : null;

  // Breadth-first, but stepping onto a critical activity is free, so the path shown follows the
  // critical path wherever it can (a 0-1 BFS).
  const target: Point = `F:${finish.taskId}`;
  const first: Point = `F:${start.taskId}`;
  const cameFrom = new Map<Point, { point: Point | null; type: string | null }>([[first, { point: null, type: null }]]);
  const cost = new Map<Point, number>([[first, 0]]);
  const done = new Set<Point>();
  const stops = new Map<string, string>();
  const queue: Point[] = [first];
  while (queue.length > 0) {
    const point = queue.shift()!;
    if (done.has(point)) continue;
    done.add(point);
    if (point === target) break;
    const id = point.slice(2);
    const out = [...(next.get(point) ?? [])];
    if (point.startsWith("S:")) out.push({ to: `F:${id}`, type: "", from: id });
    let moved = false;
    for (const { to, type } of out) {
      const activity = activities.get(to.slice(2))!;
      const reason = to.slice(2) === id ? null : blocked(activity);
      if (reason) {
        stops.set(activity.taskId, reason);
        continue;
      }
      moved = true;
      const step = to.slice(2) === id || isCritical(activity) ? 0 : 1;
      const total = cost.get(point)! + step;
      if (total >= (cost.get(to) ?? Infinity)) continue;
      cost.set(to, total);
      cameFrom.set(to, { point, type });
      if (step === 0) queue.unshift(to);
      else queue.push(to);
    }
    if (!moved && point.startsWith("F:") && !stops.has(id))
      stops.set(id, (next.get(point) ?? []).length === 0 ? "No successor, so the delay ends here" : "Every successor is held in place");
  }

  const base = { start: start.taskId, finish: finish.taskId };
  if (!done.has(target)) {
    return {
      ...base,
      passed: false,
      path: [],
      stops: [...stops]
        .filter(([taskId]) => taskId !== start.taskId)
        .slice(0, MAX_STOPS).map(([taskId, reason]) => ({ taskId, reason })),
    };
  }

  // Walk back from the finish, keeping one entry per activity with the link that pushed it.
  const path: { taskId: string; via: string | null; from: string | null }[] = [];
  for (let point: Point | null = target; point; ) {
    const step: { point: Point | null; type: string | null } = cameFrom.get(point)!;
    const id = point.slice(2);
    const prevId = step.point?.slice(2) ?? null;
    if (path[0]?.taskId !== id) path.unshift({ taskId: id, via: null, from: null });
    if (prevId !== null && prevId !== id) {
      path[0].via = step.type;
      path[0].from = prevId;
    }
    point = step.point;
  }
  return { ...base, passed: true, path, stops: [] };
}
