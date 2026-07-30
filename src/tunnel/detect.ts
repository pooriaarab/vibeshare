/**
 * Default “is this binary on PATH?” check used by every CLI-backed provider.
 */
import { access, constants } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

/**
 * Resolve whether `command` can be executed. Absolute/relative paths are
 * checked directly; bare names are searched on `PATH` (with Windows PATHEXT).
 */
export async function commandExists(command: string): Promise<boolean> {
  if (!command) return false;

  if (command.includes('/') || command.includes('\\')) {
    return isExecutable(command);
  }

  const pathEnv = process.env.PATH ?? '';
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, ext ? `${command}${ext}` : command);
      if (await isExecutable(candidate)) return true;
      // Windows often stores tools as `foo.EXE` while the call is `foo`.
      if (process.platform === 'win32' && ext) {
        const lower = join(dir, `${command}${ext.toLowerCase()}`);
        if (await isExecutable(lower)) return true;
      }
    }
  }
  return false;
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.F_OK);
    // On Windows X_OK is unreliable; F_OK is enough for "looks installed".
    if (process.platform !== 'win32') {
      await access(file, constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}
