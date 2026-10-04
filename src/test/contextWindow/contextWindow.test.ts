import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WINDOWS, SCENARIOS } from './scenarios.js';
import { formatReport, runScenario } from './harness.js';

// O4C_CTX_WINDOWS=4096,57344 narrows the matrix; default is the full window sweep.
const windows = process.env.O4C_CTX_WINDOWS
  ? process.env.O4C_CTX_WINDOWS.split(',').map((w) => Number(w.trim()))
  : DEFAULT_WINDOWS;

for (const spec of SCENARIOS) {
  for (const window of spec.windows ?? windows) {
    test(`${spec.name} @ ${window}`, async () => {
      const result = await runScenario(spec, window);
      console.log(formatReport(result));
      const first = result.violations[0];
      assert.equal(
        first,
        undefined,
        first ? `${first.invariant} at request ${first.step}: ${first.detail}` : undefined,
      );
      spec.check?.(result);
    });
  }
}
