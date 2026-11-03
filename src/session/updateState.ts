/** Whether /update may go online (I3): set by cli.ts from secure mode. */
let secure = false;

export function setUpdateSecureMode(on: boolean): void {
  secure = on;
}

export function updateRefusedBySecureMode(): boolean {
  return secure;
}
