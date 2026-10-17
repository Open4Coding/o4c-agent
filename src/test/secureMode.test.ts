import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SECURE_MODE_CONFIG_KEY,
  allowedInSecureMode,
  egressClassOf,
  egressClassOfUrl,
  secureModeFromScopes,
  secureModeProviderRefusal,
} from '../session/secureMode.js';

/**
 * Secure/air-gapped mode - `PATH_FORWARD.md` §1a, checklist item 21f.
 *
 * The thing under test is a security boundary, so these lean on the cases that would quietly
 * widen it: a hostname that merely looks loopback, a private range's edges, and the config
 * ratchet that stops a cloned repo switching the mode off.
 */

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

test('loopback forms are loopback, including the whole 127/8 and IPv6', () => {
  for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '::ffff:127.0.0.1', 'api.localhost']) {
    assert.equal(egressClassOf(host), 'loopback', host);
  }
});

test('a hostname that only looks loopback is public, not loopback', () => {
  // The attack the numeric match exists to stop: a public name with a loopback-looking prefix.
  for (const host of ['127.0.0.1.example.com', 'localhost.example.com', 'notlocalhost', '1270.0.0.1']) {
    assert.equal(egressClassOf(host), 'public', host);
  }
});

test('RFC1918 and link-local addresses are private', () => {
  for (const host of ['10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.254', '192.168.0.128', '169.254.1.1']) {
    assert.equal(egressClassOf(host), 'private', host);
  }
});

test('192.168.0.128 - this project\'s own model server - is permitted in secure mode', () => {
  // The case that decided the three-class design: classifying the LAN model server as egress
  // would make secure mode refuse PATH_FORWARD §10's entire reference setup.
  assert.equal(egressClassOf('192.168.0.128'), 'private');
  assert.equal(allowedInSecureMode(egressClassOf('192.168.0.128')), true);
});

test('the edges of 172.16/12 are not over-claimed', () => {
  assert.equal(egressClassOf('172.15.255.255'), 'public');
  assert.equal(egressClassOf('172.16.0.0'), 'private');
  assert.equal(egressClassOf('172.31.255.255'), 'private');
  assert.equal(egressClassOf('172.32.0.0'), 'public');
});

test('IPv6 ULA and link-local are private; other IPv6 is public', () => {
  assert.equal(egressClassOf('[fd00::1]'), 'private');
  assert.equal(egressClassOf('fc00::1'), 'private');
  assert.equal(egressClassOf('[fe80::1]'), 'private');
  assert.equal(egressClassOf('[2606:4700::1111]'), 'public');
});

test('carrier-grade NAT is public, because a VPN-reached host is off-site', () => {
  // 100.64/10 is RFC6598 ISP space and also Tailscale's range - the packets really do cross the
  // internet, encrypted but off-site, which is what §1a.2 is about.
  assert.equal(egressClassOf('100.64.0.1'), 'public');
  assert.equal(egressClassOf('100.100.100.100'), 'public');
});

test('a bare LAN name is public, since deciding otherwise would need a DNS lookup', () => {
  // Documented limitation rather than an oversight: this runs while parsing config, before any
  // trust decision, on a path that must not do network I/O.
  assert.equal(egressClassOf('phoebe'), 'public');
  assert.equal(egressClassOf('my-server.lan'), 'public');
  // mDNS is the exception: `.local` resolves only on the local link by definition.
  assert.equal(egressClassOf('phoebe.local'), 'private');
});

test('public addresses are public', () => {
  for (const host of ['api.anthropic.com', '8.8.8.8', '1.1.1.1', '0.0.0.0']) {
    assert.equal(egressClassOf(host), 'public', host);
  }
});

test('egressClassOfUrl reads the host out of a url, and an unparseable one is public', () => {
  assert.equal(egressClassOfUrl('http://127.0.0.1:8080'), 'loopback');
  assert.equal(egressClassOfUrl('http://192.168.0.128:8080/v1'), 'private');
  assert.equal(egressClassOfUrl('https://api.example.com'), 'public');
  assert.equal(egressClassOfUrl('not a url'), 'public');
  assert.equal(egressClassOfUrl(''), 'public');
});

test('allowedInSecureMode permits loopback and private, refuses public', () => {
  assert.equal(allowedInSecureMode('loopback'), true);
  assert.equal(allowedInSecureMode('private'), true);
  assert.equal(allowedInSecureMode('public'), false);
});

// ---------------------------------------------------------------------------------------------
// The config ratchet
// ---------------------------------------------------------------------------------------------

test('secure mode is off when no scope sets it', () => {
  assert.equal(secureModeFromScopes([{}, {}, {}]), false);
  assert.equal(secureModeFromScopes([]), false);
});

test('any scope may turn secure mode ON', () => {
  assert.equal(secureModeFromScopes([{ [SECURE_MODE_CONFIG_KEY]: true }, {}, {}]), true);
  assert.equal(secureModeFromScopes([{}, { [SECURE_MODE_CONFIG_KEY]: true }, {}]), true);
  assert.equal(secureModeFromScopes([{}, {}, { [SECURE_MODE_CONFIG_KEY]: true }]), true);
});

test('a narrower scope cannot turn secure mode OFF - the ratchet', () => {
  // The hole this exists to close: under the ordinary global -> local -> personal cascade a
  // cloned repo's .o4c/config.json would override the machine's own global setting, so being
  // handed a repo could switch off an air-gapped machine's egress boundary.
  const globalOn = { [SECURE_MODE_CONFIG_KEY]: true };
  const projectOff = { [SECURE_MODE_CONFIG_KEY]: false };
  assert.equal(secureModeFromScopes([globalOn, projectOff, {}]), true);
  assert.equal(secureModeFromScopes([globalOn, {}, projectOff]), true);
});

test('only the literal boolean true counts, not a truthy string', () => {
  // A hand-edited `"secureMode": "yes"` must not read as on-by-accident, and more importantly a
  // `"false"` string must not read as off when another scope really did set it.
  assert.equal(secureModeFromScopes([{ [SECURE_MODE_CONFIG_KEY]: 'true' }]), false);
  assert.equal(secureModeFromScopes([{ [SECURE_MODE_CONFIG_KEY]: 1 }]), false);
});

// ---------------------------------------------------------------------------------------------
// The provider gate - the half §1a calls the bigger hole
// ---------------------------------------------------------------------------------------------

test('a cloud provider is refused by name, whatever its base url says', () => {
  const refusal = secureModeProviderRefusal('anthropic', 'http://127.0.0.1:8080');
  assert.ok(refusal, 'anthropic must be refused in secure mode');
  assert.ok(refusal.includes('anthropic'), refusal);
  // Says what to do about it, not just that it failed.
  assert.ok(refusal.includes('secureMode'), refusal);
});

test('a local provider on loopback or the LAN is allowed', () => {
  assert.equal(secureModeProviderRefusal('local', 'http://127.0.0.1:8080'), undefined);
  assert.equal(secureModeProviderRefusal('local', 'http://192.168.0.128:8080'), undefined);
  assert.equal(secureModeProviderRefusal('local', undefined), undefined);
});

test('a local provider pointed off-site is refused, and the message names the fix', () => {
  const refusal = secureModeProviderRefusal('local', 'https://models.example.com/v1');
  assert.ok(refusal, 'an off-site base url must be refused');
  assert.ok(refusal.includes('models.example.com'), refusal);
  // The DNS limitation is the thing a user will actually trip over, so it is in the message.
  assert.ok(refusal.includes('IP address'), refusal);
});
