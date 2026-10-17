/**
 * Secure/air-gapped mode - `PATH_FORWARD.md` §1a.2 and §1a.3, wired up 2026-10-17 (checklist 21f).
 *
 * §1a asks for "an explicit **mode distinction**: secure/air-gapped mode (local models + local MCP
 * servers only, zero egress) vs. connected mode (cloud APIs permitted) - not a single implicit
 * default", and says what is missing is "a formal mode boundary that governs *which* providers/
 * tools are even reachable in each mode". This file is that boundary.
 *
 * **It deliberately covers the provider as well as MCP servers.** §1a names the provider as the
 * bigger hole in so many words - "Anthropic's API (and any cloud LLM) is itself 'phoning home' -
 * every call sends code/prompts off-machine ... disqualifying for secure/air-gapped use". A secure
 * mode that gated MCP and let every prompt go to a cloud API would be security theatre.
 */

/**
 * How far a request to a host travels. Three classes, not two, and the middle one is the whole
 * reason this type exists rather than reusing `reachOf`'s local/remote.
 *
 * `reachOf` (`src/mcp/serverConfig.ts`) answers "does this leave the machine", which is the right
 * question for the confirmation dialog. Secure mode is asking a different one: "does this leave the
 * **site**". Those come apart for exactly the deployment this project is built around - a
 * LAN-attached model server (the dual-3090 box at `192.168.0.128`, which is what every local-model
 * benchmark in `PATH_FORWARD.md` §10 runs against). Classifying that as egress would make secure
 * mode refuse this project's own reference architecture, and anyone hitting that would turn the
 * mode off, which is worse than a mode with an honest boundary.
 */
export type EgressClass = 'loopback' | 'private' | 'public';

/** Dotted-quad to four numbers, or `undefined` when it is not one. */
function ipv4Octets(host: string): number[] | undefined {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return undefined;
  const numbers = parts.map(Number);
  return numbers.every((n) => n <= 255) ? numbers : undefined;
}

/**
 * Classifies a hostname as taken from a URL (so IPv6 arrives bracketed and lower-cased).
 *
 * **A name that is not an address is `public`, which is the cautious answer and sometimes the
 * wrong one.** `phoebe` or `my-server.lan` may well resolve to a LAN address, but deciding that
 * would mean resolving DNS, and this runs while parsing config - before a trust decision, on
 * attacker-controllable text, on a path that must not do network I/O. The practical consequence
 * is worth stating plainly because a user will hit it: **in secure mode, give a LAN host as its
 * IP address** (`http://192.168.0.128:8080`), not as a bare name.
 */
export function egressClassOf(hostname: string): EgressClass {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (host === 'localhost' || host === '::1' || host === '::ffff:127.0.0.1') return 'loopback';
  if (host.endsWith('.localhost')) return 'loopback';

  const octets = ipv4Octets(host);
  if (octets) {
    const [a, b] = octets;
    // 127.0.0.0/8 entire, not just 127.0.0.1. Matched numerically so "127.0.0.1.example.com"
    // cannot pass by merely starting with 127.
    if (a === 127) return 'loopback';
    // RFC1918, the three classic private ranges.
    if (a === 10) return 'private';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    // RFC3927 link-local: same physical segment by definition, so it cannot leave the site.
    if (a === 169 && b === 254) return 'private';
    // Everything else, 0.0.0.0 and 100.64/10 (RFC6598 carrier NAT) included. CGNAT is explicitly
    // NOT private here: it is an ISP's space and it is also what Tailscale hands out, where the
    // packets really do cross the internet - encrypted, but off-site, which is the thing §1a.2 is
    // about. A VPN-reached server is a connected-mode server.
    return 'public';
  }

  // IPv6 ULA (fc00::/7 - fc.. and fd..) is the RFC1918 equivalent; fe80::/10 is link-local.
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return 'private';
  if (/^fe[89ab][0-9a-f]:/.test(host)) return 'private';
  // mDNS: `.local` is resolvable only on the local link, so a name in it cannot be off-site.
  if (host.endsWith('.local')) return 'private';

  return 'public';
}

/** `undefined` for an unparseable URL, which callers treat as `public`. */
export function egressClassOfUrl(url: string): EgressClass {
  try {
    return egressClassOf(new URL(url).hostname);
  } catch {
    return 'public';
  }
}

/** Whether secure mode permits reaching this class at all. */
export function allowedInSecureMode(egress: EgressClass): boolean {
  return egress !== 'public';
}

/** The `config.json` key. Core config, not MCP-namespaced: it governs the provider too. */
export const SECURE_MODE_CONFIG_KEY = 'secureMode';

/**
 * Resolves secure mode across config scopes as a **ratchet: any scope may turn it on, none may
 * turn it off.**
 *
 * This is the one config key that does not use the ordinary global -> local -> personal override
 * cascade, and the reason is a real hole rather than a preference. Under the normal cascade a
 * project's `.o4c/config.json` overrides the global value - and project config is, in this
 * codebase's own words about the trust gate, "attacker-controlled text from whoever's repo this
 * is". A repo that could set `secureMode: false` could switch off an air-gapped machine's egress
 * boundary by being cloned. Taking the logical OR means a repo can only ever tighten it.
 *
 * The cost is that turning it off has to be done in the scope that turned it on, which is the
 * correct inconvenience: disabling an egress boundary should be deliberate and local to the person
 * who owns the machine.
 */
export function secureModeFromScopes(scopes: readonly Record<string, unknown>[]): boolean {
  return scopes.some((scope) => scope[SECURE_MODE_CONFIG_KEY] === true);
}

/**
 * Why a provider is refused in secure mode, or `undefined` when it is allowed.
 *
 * Returns the message rather than a boolean so the one caller does not have to re-derive the
 * wording, and so the wording is assertable in a test. `provider` is the resolved provider name
 * and `baseUrl` whatever it was configured with.
 */
export function secureModeProviderRefusal(provider: string, baseUrl: string | undefined): string | undefined {
  // A cloud provider is public by definition and there is no base URL that makes it otherwise -
  // checked by name rather than by URL because the SDK's endpoint is not ours to inspect.
  if (provider !== 'local') {
    return `Secure mode is on, so the "${provider}" provider is refused: every request to it sends prompts and code off this network. Use a local model, or turn secureMode off in the config scope that set it.`;
  }
  if (!baseUrl) return undefined;
  const egress = egressClassOfUrl(baseUrl);
  if (allowedInSecureMode(egress)) return undefined;
  return `Secure mode is on, so the model server at ${baseUrl} is refused: it is not on this machine or this network. If it is a LAN host, give it as an IP address rather than a name - a name cannot be checked without a DNS lookup, so it is treated as off-site.`;
}
