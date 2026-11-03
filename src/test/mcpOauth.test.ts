import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileOAuthProvider, oauthFile, waitForCode } from '../mcp/oauth.js';
import { parseServers } from '../mcp/serverConfig.js';

test('the provider keeps registration, tokens and the PKCE verifier in its own file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'o4c-oauth-'));
  try {
    const opened: string[] = [];
    const p = new FileOAuthProvider('remote', join(dir, 'remote.json'), 41234, (u) => void opened.push(u));
    assert.equal(p.redirectUrl, 'http://127.0.0.1:41234/callback');
    assert.deepEqual(p.clientMetadata.redirect_uris, ['http://127.0.0.1:41234/callback']);
    assert.equal(p.tokens(), undefined);
    assert.throws(() => p.codeVerifier(), /No PKCE code verifier/);
    p.saveClientInformation({ client_id: 'abc' } as never);
    p.saveTokens({ access_token: 't1', token_type: 'Bearer' } as never);
    p.saveCodeVerifier('v1');
    const again = new FileOAuthProvider('remote', join(dir, 'remote.json'), 41234);
    assert.equal((again.clientInformation() as { client_id: string }).client_id, 'abc');
    assert.equal(again.tokens()!.access_token, 't1');
    assert.equal(again.codeVerifier(), 'v1');
    p.redirectToAuthorization(new URL('https://auth.example.com/authorize?x=1'));
    assert.deepEqual(opened, ['https://auth.example.com/authorize?x=1']);
    assert.match(oauthFile('my server', '/h'), /[\\/]h[\\/]\.o4c[\\/]mcp-oauth[\\/]my_server\.json$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the loopback callback hands back the code, or the error the browser brought', async () => {
  const port = 41000 + Math.floor(Math.random() * 500);
  const waiting = waitForCode(port, 5000);
  await new Promise((r) => setTimeout(r, 100));
  const res = await fetch(`http://127.0.0.1:${port}/callback?code=xyz&state=s`);
  assert.match(await res.text(), /Signed in/);
  assert.equal(await waiting, 'xyz');

  const port2 = port + 600;
  const failing = waitForCode(port2, 5000);
  failing.catch(() => undefined); // asserted below; this only stops it counting as unhandled meanwhile
  await new Promise((r) => setTimeout(r, 100));
  await fetch(`http://127.0.0.1:${port2}/callback?error=access_denied`);
  await assert.rejects(failing, /Sign-in failed: access_denied/);
});

test('"oauth": true is kept for http servers', () => {
  const { servers, problems } = parseServers({ remote: { transport: 'http', url: 'https://mcp.example.com/mcp', oauth: true } });
  assert.deepEqual(problems, []);
  assert.equal(servers[0]!.oauth, true);
});
