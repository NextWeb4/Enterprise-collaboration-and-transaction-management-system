import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const dataDir = process.env.DATA_DIR ?? join(process.env.LOCALAPPDATA ?? homedir(), 'collab-office-bootstrap', 'data');
const apiPort = process.env.PORT ?? '3000';
const env = {
  ...process.env,
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  DATA_DIR: dataDir,
  WEB_ORIGIN: 'http://127.0.0.1:5173',
  VITE_API_ORIGIN: `http://127.0.0.1:${apiPort}`,
};
const children = [];
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) if (child.exitCode === null) child.kill();
}

function start(name, script, args) {
  const child = spawn(process.execPath, [resolve(script), ...args], { stdio: 'inherit', env });
  children.push(child);
  child.on('error', (error) => {
    console.error(`[dev] ${name} failed: ${error.message}`);
    stop(1);
  });
  child.on('exit', (code, signal) => {
    if (!stopping) {
      console.error(`[dev] ${name} stopped (${signal ?? code})`);
      stop(code || 1);
    }
  });
}

console.log(`[dev] data directory: ${dataDir}`);
start('api', 'node_modules/tsx/dist/cli.mjs', ['app/backend/src/server.ts']);
start('web', 'node_modules/vite/bin/vite.js', ['--config', 'app/frontend/vite.config.ts']);
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
