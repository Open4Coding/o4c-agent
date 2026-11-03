/**
 * Span tracing for one turn (plan 0006 K3, R06 #49): where a turn's time went - the model calls
 * (prompt, cached and generated tokens, rate), the tool calls (bytes, error) and any compaction,
 * each timed and parented to the turn.
 *
 * In memory until the turn ends, then handed to a sink in one go (`session/spans.ts` writes it to
 * history.db in one transaction). Nothing is written while the turn runs, so tracing adds a few
 * object allocations per call and no I/O on the hot path. With no tracer set the loop allocates
 * nothing at all.
 */
export type SpanKind = 'turn' | 'model' | 'tool' | 'compaction';

export interface PendingSpan {
  /** Unique within the turn; the store assigns real row ids and maps parents across. */
  readonly key: number;
  readonly parent: number | undefined;
  readonly kind: SpanKind;
  readonly name: string;
  /** Wall-clock start, epoch ms - for display and pruning. */
  readonly startedAt: number;
  durMs: number;
  attrs: Record<string, unknown>;
}

export interface SpanHandle {
  readonly key: number;
  end(attrs?: Record<string, unknown>): void;
  /** Drop the span - started speculatively and it turned out nothing happened (a compaction check). */
  discard(): void;
}

/** What `start` returns when nothing is traced: every call is a no-op. */
export const NO_SPAN: SpanHandle = { key: 0, end: () => {}, discard: () => {} };

export class TurnTracer {
  private spans: PendingSpan[] = [];
  private nextKey = 1;

  constructor(
    private readonly sink: (spans: readonly PendingSpan[]) => void,
    private readonly clock: () => number = () => performance.now(),
  ) {}

  start(kind: SpanKind, name: string, parent?: SpanHandle): SpanHandle {
    const t0 = this.clock();
    const span: PendingSpan = {
      key: this.nextKey++,
      parent: parent && parent !== NO_SPAN ? parent.key : undefined,
      kind,
      name,
      startedAt: Date.now(),
      durMs: -1,
      attrs: {},
    };
    this.spans.push(span);
    let open = true;
    return {
      key: span.key,
      end: (attrs) => {
        if (!open) return;
        open = false;
        span.durMs = Math.round((this.clock() - t0) * 10) / 10;
        if (attrs) span.attrs = attrs;
      },
      discard: () => {
        open = false;
        this.spans = this.spans.filter((s) => s !== span);
      },
    };
  }

  /** Hands the finished turn to the sink and starts empty. A span never ended is dropped. */
  flush(): void {
    const done = this.spans.filter((s) => s.durMs >= 0);
    this.spans = [];
    this.nextKey = 1;
    if (done.length > 0) this.sink(done);
  }
}
