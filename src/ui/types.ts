export type LineKind = 'system' | 'user' | 'tool_call' | 'tool_result' | 'final' | 'error' | 'splash';

export interface Line {
  kind: LineKind;
  text: string;
}
