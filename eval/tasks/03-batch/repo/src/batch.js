/** Runs each job (an async function) and resolves with their results, in job order. */
export async function runAll(jobs) {
  const results = [];
  jobs.forEach(async (job, i) => {
    results[i] = await job();
  });
  return results;
}
