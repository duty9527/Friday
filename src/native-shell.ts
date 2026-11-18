import { spawn } from 'node:child_process';
import type { BashOperations } from '@earendil-works/pi-coding-agent';

export class NativeCommandInterrupted extends Error {}
export class NativeCommandTimeoutError extends Error {}

const MAX_TIMEOUT_MS = 2_147_483_647;

export function nativeShellOperations(): BashOperations {
  return { exec: async (command, cwd, { onData, signal, timeout, env }) => {
    signal?.throwIfAborted();
    if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0 || timeout * 1000 > MAX_TIMEOUT_MS)) {
      throw new Error('Invalid command timeout');
    }
    return new Promise((resolve, reject) => {
      const child = spawn('/bin/bash', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let interrupted = false;
      let timedOut = false;
      let finished = false;
      let deadline: NodeJS.Timeout | undefined;
      let drain: NodeJS.Timeout | undefined;
      const killGroup = () => {
        if (!child.pid) return;
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) interrupted = true; }
      };
      const onAbort = () => { interrupted = true; killGroup(); };
      const onTimeout = () => {
        if (signal?.aborted) interrupted = true;
        else timedOut = true;
        killGroup();
      };
      const cleanup = () => { clearTimeout(deadline); clearTimeout(drain); signal?.removeEventListener('abort', onAbort); };
      child.stdout.on('data', onData); child.stderr.on('data', onData);
      child.once('error', error => {
        if (finished) return;
        finished = true; cleanup(); reject(error);
      });
      child.once('exit', () => {
        killGroup();
        drain = setTimeout(() => {
          if (!timedOut) interrupted = true;
          child.stdout.destroy(); child.stderr.destroy();
        }, 1000);
      });
      child.once('close', (code, terminationSignal) => {
        if (finished) return;
        finished = true; cleanup();
        if (timedOut && !signal?.aborted) {
          reject(new NativeCommandTimeoutError(`timeout:${timeout}`));
        } else if (interrupted || terminationSignal || code === null) {
          reject(new NativeCommandInterrupted('Command timed out, was interrupted or terminated abnormally; side effects are unconfirmed'));
        } else resolve({ exitCode: code });
      });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      if (timeout !== undefined) deadline = setTimeout(onTimeout, timeout * 1000);
    });
  } };
}
