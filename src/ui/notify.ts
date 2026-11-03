import { spawn } from 'node:child_process';
import { allowedInSecureMode, egressClassOfUrl } from '../session/secureMode.js';

/**
 * Notifications (plan 0006 E12): when a long turn ends, or an approval is waiting, tell the user
 * who has looked away. `bell` writes the terminal bell (most terminals flash or ping the tab);
 * `toast` asks the OS - a Windows tray balloon through PowerShell, macOS `osascript`, Linux
 * `notify-send` - and never blocks or fails the turn. The message goes through an environment
 * variable, not the command line, so nothing in it needs quoting.
 */
export type NotifyMode = 'off' | 'bell' | 'toast' | 'both';
export const NOTIFY_CONFIG_KEY = 'notify';
export const NOTIFY_AFTER_CONFIG_KEY = 'notifyAfterSeconds';
export const DEFAULT_NOTIFY: NotifyMode = 'bell';
export const DEFAULT_NOTIFY_AFTER_SECONDS = 20;

export function parseNotifyMode(v: unknown): NotifyMode {
  return v === 'off' || v === 'bell' || v === 'toast' || v === 'both' ? v : DEFAULT_NOTIFY;
}

/** A finished turn notifies only when it ran long enough to have been walked away from. */
export function shouldNotifyTurn(mode: NotifyMode, elapsedMs: number, afterSeconds = DEFAULT_NOTIFY_AFTER_SECONDS): boolean {
  return mode !== 'off' && elapsedMs >= afterSeconds * 1000;
}

const WIN_TOAST = [
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  '$n = New-Object System.Windows.Forms.NotifyIcon',
  '$n.Icon = [System.Drawing.SystemIcons]::Information',
  '$n.Visible = $true',
  "$n.ShowBalloonTip(5000, 'o4c', $env:O4C_NOTIFY_MSG, 'Info')",
  'Start-Sleep -Seconds 6',
  '$n.Dispose()',
].join('; ');

export function toastCommand(platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
  if (platform === 'win32') return { cmd: 'powershell', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', WIN_TOAST] };
  if (platform === 'darwin') return { cmd: 'osascript', args: ['-e', 'display notification (system attribute "O4C_NOTIFY_MSG") with title "o4c"'] };
  return { cmd: 'sh', args: ['-c', 'notify-send o4c "$O4C_NOTIFY_MSG"'] };
}

export interface NotifyDeps {
  write?: (s: string) => void;
  launch?: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => void;
  platform?: NodeJS.Platform;
}

const launchDetached = (cmd: string, args: string[], env: NodeJS.ProcessEnv) => {
  try {
    const child = spawn(cmd, args, { env, detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // A missing notifier is never worth an error.
  }
};

/**
 * ntfy (plan 0006 H3): with config `ntfyUrl` (https://ntfy.sh/<your-topic>, or a self-hosted
 * server), the same events also go to a phone. Fire and forget, 5 s timeout, never in the way of a
 * turn. In secure mode only a local or LAN ntfy host is used - a public one would be the off-site
 * egress secure mode exists to stop.
 */
export const NTFY_URL_KEY = 'ntfyUrl';
let ntfy: { url?: string; secureMode: boolean; post: (url: string, body: string) => Promise<unknown> } = {
  secureMode: false,
  post: (url, body) => fetch(url, { method: 'POST', body, headers: { Title: 'o4c', Tags: 'robot' }, signal: AbortSignal.timeout(5000) }),
};

export function setNtfy(o: { url?: string; secureMode?: boolean; post?: (url: string, body: string) => Promise<unknown> }): void {
  ntfy = { ...ntfy, ...o };
}

/** Whether a message would go to ntfy right now, and if not, why. */
export function ntfyTarget(): { url?: string; refused?: string } {
  const url = ntfy.url?.trim();
  if (!url) return {};
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { refused: `ntfyUrl is not a URL: ${url}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { refused: 'ntfyUrl must be http or https' };
  if (ntfy.secureMode && !allowedInSecureMode(egressClassOfUrl(url))) return { refused: 'secure mode is on and the ntfy server is off-site' };
  return { url };
}

export function notifyUser(mode: NotifyMode, message: string, deps: NotifyDeps = {}): void {
  if (mode === 'off') return;
  const target = ntfyTarget();
  if (target.url) void ntfy.post(target.url, message.slice(0, 500)).catch(() => undefined);
  // The bell only means something on a terminal (tests and pipes would just get a stray byte).
  const write = deps.write ?? (process.stdout.isTTY ? (s: string) => process.stdout.write(s) : undefined);
  if ((mode === 'bell' || mode === 'both') && write) write(String.fromCharCode(7));
  if (mode === 'toast' || mode === 'both') {
    const { cmd, args } = toastCommand(deps.platform);
    (deps.launch ?? launchDetached)(cmd, args, { ...process.env, O4C_NOTIFY_MSG: message.slice(0, 200) });
  }
}
