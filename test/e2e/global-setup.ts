import { exec } from '../support/exec.js';

/** Builds `dist/` so the e2e suite runs the bundle the hub serves. */
export default function setup(): void {
  const result = exec('pnpm', ['build']);
  if (result.status !== 0) throw new Error(`pnpm build failed:\n${result.stdout}${result.stderr}`);
}
