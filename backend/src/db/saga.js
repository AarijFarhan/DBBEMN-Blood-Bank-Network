/**
 * Compensating-transaction saga for work that spans more than one database.
 *
 * Why this exists: the admin delete routes remove rows from `catalog` (the
 * catalog node) and from every city shard, and in single-node mode that was one
 * SERIALIZABLE transaction. PostgreSQL cannot span two connections in one
 * transaction, so once each city is its own instance the old approach would
 * silently commit half a delete. Two-phase commit is not available either,
 * because the nodes are independent servers with no shared coordinator.
 *
 * So each step runs in its own node-local transaction and registers an undo
 * action. If a later step fails, the undo actions run in reverse order. This
 * gives all-or-nothing behaviour without distributed locking, at the cost of
 * needing to be able to restore deleted rows, which is why every destructive
 * step captures `RETURNING *` first.
 *
 * Honest limitation: compensation is best effort. If a step's undo itself fails
 * (node down mid-compensation) the database is left partially deleted and the
 * error is reported, not swallowed. A production deployment would additionally
 * want a durable intent log so an interrupted saga can be finished on restart.
 */

export class SagaStepError extends Error {
  constructor(stepName, cause, compensations) {
    super(`Saga failed at step "${stepName}": ${cause.message}`);
    this.name = "SagaStepError";
    this.code = "SAGA_FAILED";
    this.step = stepName;
    this.cause = cause;
    // Rows the undo pass managed to put back, surfaced so an operator can see
    // exactly how far the rollback got.
    this.compensated = compensations;
  }
}

/**
 * Run steps in order; on failure undo everything already applied, newest first.
 *
 * Contract: a step's `run()` resolves to `{ value?, compensate? }`, where
 * `compensate` is a **function**. The function is pulled out here and the rest
 * is treated as the step's result, because a step that returns a plain object
 * (counts, ids) is the common case and mixing the two used to make every undo
 * silently report "not-reversible".
 *
 * @param {string} name            label used in logs and error messages
 * @param {Array<{name: string, run: Function}>} steps
 * @param {(event: object) => void} [log]
 */
export async function runSaga(name, steps, log = () => {}) {
  const applied = [];
  const results = [];

  for (const step of steps) {
    try {
      const outcome = await step.run();
      const compensate = typeof outcome?.compensate === "function" ? outcome.compensate : null;
      applied.push({ name: step.name, compensate });
      results.push({ name: step.name, value: withoutCompensation(outcome) });
      log({ saga: name, step: step.name, status: "applied" });
    } catch (error) {
      log({ saga: name, step: step.name, status: "failed", error: error.message });
      const compensated = await compensateAll(name, applied, log);
      throw new SagaStepError(step.name, error, compensated);
    }
  }

  return {
    saga: name,
    steps: applied.map((entry) => entry.name),
    results,
  };
}

/** Drop the undo closure from a step result so it is not serialised into logs. */
function withoutCompensation(outcome) {
  if (!outcome || typeof outcome !== "object") return outcome;
  const { compensate, ...rest } = outcome;
  void compensate;
  return rest;
}

async function compensateAll(name, applied, log) {
  const compensated = [];
  // Reverse order: later steps may depend on rows earlier steps removed.
  for (const entry of [...applied].reverse()) {
    if (typeof entry.compensate !== "function") {
      compensated.push({ step: entry.name, restored: "not-reversible" });
      log({ saga: name, step: entry.name, status: "no-compensation" });
      continue;
    }
    try {
      await entry.compensate();
      compensated.push({ step: entry.name, restored: "ok" });
      log({ saga: name, step: entry.name, status: "compensated" });
    } catch (error) {
      compensated.push({ step: entry.name, restored: "failed", error: error.message });
      log({ saga: name, step: entry.name, status: "compensation-failed", error: error.message });
    }
  }
  return compensated;
}

/**
 * Build an undo action that re-inserts rows captured by a DELETE ... RETURNING *.
 *
 * The table name is interpolated, so it must come from `schemasFor()` or a
 * hard-coded literal and never from request input.
 */
export function restoreRows(table) {
  return async function restore(executor, capturedRows) {
    if (!capturedRows || capturedRows.length === 0) return 0;
    const columns = Object.keys(capturedRows[0]);
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
    const quoted = columns.map((column) => `"${column}"`).join(", ");
    for (const row of capturedRows) {
      await executor.query(
        `INSERT INTO ${table} (${quoted}) VALUES (${placeholders})`,
        columns.map((column) => row[column]),
      );
    }
    return capturedRows.length;
  };
}
