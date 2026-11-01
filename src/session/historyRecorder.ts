import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { CONTINUATION_TAG, type ContextEntry } from '../agent/contextEntry.js';
import type { CoreComponent, ToolCallContext } from '../agent/coreSeam.js';
import { repoRelative } from '../graph/indexer.js';
import type { InfiniteContextStore } from './infiniteContextStore.js';
import { diffEntities, snapshotEntities } from './taskEntities.js';

/**
 * Writes the session into the history store as it happens - NextUp item 13, checklist A3/A4.
 *
 * A core component (design doc 5.7) rather than a subscriber bolted onto `App.tsx`: it observes
 * every entry through `onEntry` and every `write_file` through `aroundTool`, and never changes
 * either. Both hooks are already guarded by the seam - a throwing observer is caught and reported,
 * and this component's `aroundTool` never throws on its own account (see there) - so a broken
 * store costs the history and nothing else.
 *
 * **One exchange is one task** (brief 0004, Q6). A real user message closes the previous task and
 * opens the next; everything until the next one is filed under it. A short message (under
 * `FOLLOW_UP_MAX_WORDS` words) is taken as a follow-up of the previous task and numbered under it
 * (`#502.1`) - the brief's starting rule, whose only failure is a misplaced number.
 */

/** A message with fewer words than this is filed as a follow-up of the previous task. */
export const FOLLOW_UP_MAX_WORDS = 5;

export interface HistoryRecorderOptions {
  readonly store: InfiniteContextStore;
  /** This process's session id (cli.ts decides it at startup - see `AppProps.sessionId`). */
  readonly sessionId: string;
  /** The trusted project root, for repo-relative paths. */
  readonly projectRoot: string;
  /**
   * Whether to record right now. False for the `none` context window type, whose answers are
   * one-shots that are deliberately not kept (brief, type 1). Read on every entry, so switching
   * type mid-session takes effect at once.
   */
  readonly enabled: () => boolean;
}

export class HistoryRecorder implements CoreComponent {
  readonly name = 'history-recorder';
  private sessionReady = false;
  private currentTaskId: number | undefined;

  constructor(private readonly options: HistoryRecorderOptions) {}

  /** The task the current exchange is filed under, if one is open - for search logging. */
  currentTask(): number | undefined {
    return this.currentTaskId;
  }

  onEntry(entry: ContextEntry): void {
    if (!this.options.enabled()) {
      // An exchange that started while recording was off is not continued into the store
      // half-way: it has no task, so nothing after it would be filed correctly either.
      if (entry.type === 'user' && entry.sub_type === 'input' && !isContinuation(entry)) this.closeTask();
      return;
    }
    const { store, sessionId } = this.options;

    if (entry.type === 'user' && entry.sub_type === 'input' && !isContinuation(entry)) {
      this.ensureSession(entry.content);
      // From the store, not just memory: o4c reloads itself into a fresh process after most turns,
      // so the previous exchange usually belongs to the process before this one. It is closed
      // here for the same reason - nothing else would ever close it.
      const previous = this.currentTaskId ?? store.lastTask(sessionId)?.id;
      if (previous !== undefined) store.finishTask(previous);
      this.currentTaskId = undefined;
      const followUpOf = previous !== undefined && wordCount(entry.content) < FOLLOW_UP_MAX_WORDS ? previous : undefined;
      this.currentTaskId = store.startTask({ session_id: sessionId, request: entry.content, followUpOf }).id;
    }
    // Anything before the first real message (a resumed session's notices) has no task to go to.
    if (this.currentTaskId === undefined) return;

    store.insertEntry({ ...entry, session_id: sessionId }, this.currentTaskId);

    if (entry.type === 'ai' && entry.sub_type === 'response' && entry.content.trim() !== '') {
      // The last response of the exchange is its answer; narration between tool calls is
      // overwritten by whatever comes after it.
      store.setTaskAnswer(this.currentTaskId, entry.content);
    } else if (entry.type === 'ai' && entry.sub_type === 'toolcallresponse' && looksLikeToolError(entry.content)) {
      store.addTaskError(this.currentTaskId, entry.content);
    } else if (entry.type === 'system' && entry.sub_type === 'error') {
      store.addTaskError(this.currentTaskId, entry.content);
    }
  }

  /**
   * Links a `write_file` to the definitions it changed (checklist A4). Reads the file before the
   * write, lets the write happen, then compares. Everything it does on its own account is caught:
   * the tool's result is returned untouched whatever the history side does, because a recorder
   * that could fail a write would be worse than having no history.
   */
  async aroundTool(call: ToolCallContext, next: () => Promise<string>): Promise<string> {
    const taskId = this.currentTaskId;
    const path = call.input.path;
    if (call.tool.name !== 'write_file' || taskId === undefined || typeof path !== 'string' || !this.options.enabled()) {
      return next();
    }
    const absolute = isAbsolute(path) ? path : resolve(this.options.projectRoot, path);
    const before = await readFile(absolute, 'utf-8').catch(() => '');
    const result = await next();
    if (result.startsWith('Error')) return result;

    try {
      const repoPath = repoRelative(this.options.projectRoot, absolute) ?? path;
      const { store } = this.options;
      store.addTaskFile(taskId, repoPath);
      store.addTaskEntity({ task_id: taskId, path: repoPath, entity_uid: null, name: null, kind: null, change: 'written', hash_before: null, hash_after: null });
      const after = typeof call.input.content === 'string' ? call.input.content : '';
      const [was, now] = await Promise.all([snapshotEntities(before, repoPath), snapshotEntities(after, repoPath)]);
      if (was && now) {
        for (const change of diffEntities(was, now)) store.addTaskEntity({ task_id: taskId, path: repoPath, ...change });
      }
    } catch {
      // See the doc comment: the write already happened and its result stands.
    }
    return result;
  }

  private closeTask(): void {
    if (this.currentTaskId !== undefined) this.options.store.finishTask(this.currentTaskId);
    this.currentTaskId = undefined;
  }

  private ensureSession(firstRequest: string): void {
    if (this.sessionReady) return;
    this.options.store.ensureSession({ id: this.options.sessionId, title: firstRequest.split('\n')[0].slice(0, 80), started_at: Date.now() });
    this.sessionReady = true;
  }
}

function isContinuation(entry: ContextEntry): boolean {
  return entry.tags?.includes(CONTINUATION_TAG) ?? false;
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** The built-in tools' own failure shapes: `Error ...` (read/write/glob/grep, unknown tool) and
 * `Command failed: ...` (run_shell). */
function looksLikeToolError(content: string): boolean {
  return content.startsWith('Error') || content.startsWith('Command failed');
}
