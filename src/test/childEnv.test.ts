import { test } from 'node:test';
import assert from 'node:assert/strict';
import { childEnv, clearSecrets, registerSecret, setPassKeysToShell } from '../session/redact.js';
import { runShellTool } from '../tools/runShell.js';

/** Plan 0006 C4 (Q2): commands o4c runs do not get o4c's own keys. */

test("run_shell children get neither o4c's key variables nor any variable holding a registered secret", async () => {
  const secret = 'sk-local-0123456789abcdef';
  registerSecret(secret);
  process.env.O4C_LOCAL_API_KEY = secret;
  process.env.SOME_COPY_OF_IT = secret;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-not-registered-but-named';
  process.env.ORDINARY_VAR = 'kept';
  try {
    const env = childEnv();
    assert.equal(env.O4C_LOCAL_API_KEY, undefined);
    assert.equal(env.SOME_COPY_OF_IT, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.ORDINARY_VAR, 'kept');
    assert.ok(env.PATH ?? env.Path, 'PATH survives');
    const seen = await runShellTool.execute({ command: 'node -e "console.log([process.env.O4C_LOCAL_API_KEY, process.env.SOME_COPY_OF_IT, process.env.ANTHROPIC_API_KEY, process.env.ORDINARY_VAR].join(\'|\'))"' });
    assert.equal(seen, '|||kept');

    setPassKeysToShell(true);
    assert.equal(childEnv().O4C_LOCAL_API_KEY, secret, 'opt-out passes them');
  } finally {
    setPassKeysToShell(false);
    for (const k of ['O4C_LOCAL_API_KEY', 'SOME_COPY_OF_IT', 'ANTHROPIC_API_KEY', 'ORDINARY_VAR']) delete process.env[k];
    clearSecrets();
  }
});
