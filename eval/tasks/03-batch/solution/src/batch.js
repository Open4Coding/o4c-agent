/** Runs each job (an async function) and resolves with their results, in job order. */
export async function runAll(jobs) {
  return Promise.all(jobs.map((job) => job()));
}
