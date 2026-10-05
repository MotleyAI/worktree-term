import { exec } from '../support/exec.js';

export default function setup(): void {
  const result = exec('pnpm', ['build']);
  if (result.status !== 0) throw new Error(`pnpm build failed:\n${result.stdout}${result.stderr}`);
}
