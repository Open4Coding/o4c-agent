import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

/**
 * OAuth for remote MCP servers (plan 0006 G7) - `"oauth": true` on an http server in config.
 *
 * The SDK runs the protocol (discovery, dynamic client registration, PKCE, token refresh); this
 * file is the part it leaves to the app: where the client registration and tokens are kept
 * (`~/.o4c/mcp-oauth/<server>.json`, owner-only where the OS supports it - never in config or a
 * project), opening the browser at the sign-in page, and catching the redirect on a loopback port.
 *
 * Flow: connect -> the server says 401 -> the SDK calls `redirectToAuthorization` (the browser opens
 * and the user signs in) -> the browser comes back to http://127.0.0.1:<port>/callback?code=... ->
 * `waitForCode` hands the code to `transport.finishAuth`, and o4c connects again, now with a token.
 */
export const OAUTH_CALLBACK_PORT = 33418;

interface Stored {
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
}

export function oauthFile(serverId: string, home = homedir()): string {
  return join(home, '.o4c', 'mcp-oauth', `${serverId.replace(/[^\w.-]+/g, '_')}.json`);
}

export class FileOAuthProvider implements OAuthClientProvider {
  constructor(
    private readonly serverId: string,
    private readonly file = oauthFile(serverId),
    private readonly port = OAUTH_CALLBACK_PORT,
    private readonly openUrl: (url: string) => void = openInBrowser,
  ) {}

  private read(): Stored {
    try {
      return JSON.parse(readFileSync(this.file, 'utf-8')) as Stored;
    } catch {
      return {};
    }
  }

  private write(patch: Partial<Stored>): void {
    mkdirSync(join(this.file, '..'), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ ...this.read(), ...patch }, null, 2), 'utf-8');
    try {
      chmodSync(this.file, 0o600);
    } catch {
      // Windows: the file is under the user's own profile.
    }
  }

  get redirectUrl(): string {
    return `http://127.0.0.1:${this.port}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'o4c',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    } as OAuthClientMetadata;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.read().clientInformation;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this.write({ clientInformation: info });
  }

  tokens(): OAuthTokens | undefined {
    return this.read().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.write({ tokens });
  }

  redirectToAuthorization(url: URL): void {
    this.openUrl(url.toString());
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.write({ codeVerifier });
  }

  codeVerifier(): string {
    const v = this.read().codeVerifier;
    if (!v) throw new Error(`No PKCE code verifier saved for MCP server "${this.serverId}" - start the sign-in again.`);
    return v;
  }
}

export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // The URL is also in the server's status line; the user can open it by hand.
  }
}

/** Waits for the browser to come back with `?code=` (or `?error=`) on the loopback port. */
export function waitForCode(port = OAUTH_CALLBACK_PORT, timeoutMs = 5 * 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let server: Server | undefined;
    const finish = (err: Error | undefined, code?: string) => {
      clearTimeout(timer);
      server?.close();
      if (err) reject(err);
      else resolve(code!);
    };
    const timer = setTimeout(() => finish(new Error('Timed out waiting for the browser sign-in to finish.')), timeoutMs);
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<p>${code ? 'Signed in - you can close this tab and go back to o4c.' : `Sign-in failed: ${(error ?? 'no code').replace(/[<>&]/g, '')}`}</p>`);
      finish(code ? undefined : new Error(`Sign-in failed: ${error ?? 'no code in the redirect'}`), code ?? undefined);
    });
    server.on('error', (err) => finish(err));
    server.listen(port, '127.0.0.1');
  });
}
