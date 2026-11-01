import { useEffect } from "react";
import { useInspector } from "../../inspector.ts";
import { useNav } from "../../nav.ts";
import { FIXTURE } from "./fixture.ts";
import { useGoalNav } from "./goalNav.ts";

/**
 * Screenshot mode only: `fixture&task=<id>` selects a task, `&inspect` opens the inspector on it,
 * and `&goal=<id>` opens a goal (goalFixture.ts) in the Tasks slot.
 */
export function useFixtureState(): void {
  useEffect(() => {
    if (!FIXTURE) return;
    const q = new URLSearchParams(location.search);
    const task = q.get("task");
    if (task) useNav.getState().selectTask(task);
    const goal = q.get("goal");
    if (goal) useGoalNav.getState().open(goal);
    const member = q.get("member");
    if (task && q.has("inspect")) useInspector.getState().open({ taskId: task, ...(member ? { memberId: member } : {}) });
  }, []);
}
