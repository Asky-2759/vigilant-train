import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(frontendDir, '..');
const port = process.env.PRONOUNCE_PORT || readProjectPort();
process.env.PRONOUNCE_PORT = port;

const healthUrl = `http://127.0.0.1:${port}/api/health`;
const backendPython = process.platform === 'win32'
  ? join(projectDir, '.venv', 'Scripts', 'python.exe')
  : join(projectDir, '.venv', 'bin', 'python');
const viteCli = join(frontendDir, 'node_modules', 'vite', 'bin', 'vite.js');

let backend;
let vite;
let stopping = false;
let backendError;

process.once('SIGINT', stopAll);
process.once('SIGTERM', stopAll);

try {
  if (!await backendIsAvailable()) {
    if (!existsSync(backendPython)) {
      throw new Error('Python environment not found. Run .\\setup.ps1 from the project root first.');
    }
    backend = spawn(backendPython, [
      '-m', 'uvicorn', 'backend.app:app', '--host', '127.0.0.1', '--port', port,
    ], { cwd: projectDir, stdio: 'inherit' });

    backend.once('error', (error) => {
      backendError = error;
      fail(error);
    });
    backend.once('exit', (code) => {
      if (!stopping) {
        fail(new Error(
          `Python backend exited${code === null ? '' : ` (${code})`}. ` +
          'Check the error above and run .\\setup.ps1 if backend dependencies are missing.',
        ));
      }
    });

    await waitForBackend();
  }

  vite = spawn(process.execPath, [viteCli, ...process.argv.slice(2)], {
    cwd: frontendDir,
    stdio: 'inherit',
    env: process.env,
  });
  vite.once('error', fail);
  vite.once('exit', (code) => {
    stopping = true;
    stopBackend();
    process.exitCode = code ?? 1;
  });
} catch (error) {
  fail(error);
}

function readProjectPort() {
  const defaultPort = '8077';
  const envPath = join(projectDir, '.env');
  if (!existsSync(envPath)) return defaultPort;

  const match = readFileSync(envPath, 'utf8').match(/^\s*PRONOUNCE_PORT\s*=\s*["']?(\d+)["']?\s*$/m);
  return match?.[1] ?? defaultPort;
}

async function backendIsAvailable() {
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    const health = await response.json();
    return typeof health.models === 'string';
  } catch {
    return false;
  }
}

async function waitForBackend() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (backendError) throw backendError;
    if (backend.exitCode !== null) {
      throw new Error(`Python backend exited (${backend.exitCode}) before becoming ready.`);
    }
    if (await backendIsAvailable()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  }
  throw new Error(`Python backend did not respond at ${healthUrl} within 30 seconds.`);
}

function stopBackend() {
  if (backend && backend.exitCode === null) backend.kill();
}

function stopAll() {
  if (stopping) return;
  stopping = true;
  stopBackend();
  if (vite && vite.exitCode === null) vite.kill();
}

function fail(error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
  stopAll();
}
