// Process lock for a local PGlite data directory (PGlite allows one process per directory). A stale lock left by a
// crashed process (its pid no longer exists) is taken over.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function acquireLock(dir: string, what: string): () => void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '..', `${path.basename(dir)}.lock`);
  try {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, what, at: new Date().toISOString() }), { flag: 'wx' });
  } catch {
    let holder: { pid: number; what: string; at: string } | null = null;
    try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* unreadable: treat as stale */ }
    // A lock written before the last boot is stale even if its pid is alive again (Windows reuses pids after a restart).
    const beforeBoot = holder ? Date.parse(holder.at) < Date.now() - os.uptime() * 1000 : true;
    if (holder && !beforeBoot && alive(holder.pid) && holder.pid !== process.pid)
      throw new Error(`the flight-data database is in use by process ${holder.pid} (${holder.what}, since ${holder.at}); stop it or use its API`);
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, what, at: new Date().toISOString() }));
  }
  let released = false;
  const release = () => { if (released) return; released = true; try { if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file); } catch { /* already gone */ } };
  process.once('exit', release);
  return release;
}

function alive(pid: number) { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } }
