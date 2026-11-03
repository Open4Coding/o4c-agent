import { spawn } from 'node:child_process';

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

export function notifyUser(mode: NotifyMode, message: string, deps: NotifyDeps = {}): void {
  if (mode === 'off') return;
  // The bell only means something on a terminal (tests and pipes would just get a stray byte).
  const write = deps.write ?? (process.stdout.isTTY ? (s: string) => process.stdout.write(s) : undefined);
  if ((mode === 'bell' || mode === 'both') && write) write(String.fromCharCode(7));
  if (mode === 'toast' || mode === 'both') {
    const { cmd, args } = toastCommand(deps.platform);
    (deps.launch ?? launchDetached)(cmd, args, { ...process.env, O4C_NOTIFY_MSG: message.slice(0, 200) });
  }
}
