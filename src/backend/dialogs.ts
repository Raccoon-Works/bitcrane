/**
 * The system's open and save dialogs.
 *
 * This is the only module that shows them. Every function resolves to paths in
 * the interface's form (see `pathToUi`), so callers can hand them to any backend
 * command, or to null / an empty list when the user cancels. A dialog that fails
 * to open is a bug and rejects like any other backend call.
 */
import { open, save, type DialogFilter } from '@tauri-apps/plugin-dialog';
import { tauriBackend as backend } from './tauriBackend';

/** A folder of this computer. */
export async function chooseFolder(title: string): Promise<string | null> {
  const picked = await open({ title, directory: true, multiple: false });
  return picked === null ? null : backend.pathToUi(picked);
}

/** A single file, optionally limited by `filters` and starting in `defaultPath`. */
export async function chooseFile(
  title: string,
  options: { filters?: DialogFilter[]; defaultPath?: string } = {},
): Promise<string | null> {
  const picked = await open({ title, directory: false, multiple: false, ...options });
  return picked === null ? null : backend.pathToUi(picked);
}

/** Any number of files. */
export async function chooseFiles(title: string): Promise<string[]> {
  const picked = await open({ title, directory: false, multiple: true });
  return picked === null ? [] : Promise.all(picked.map((p) => backend.pathToUi(p)));
}

/**
 * A program to open files with: an .app bundle in /Applications on the Mac, an
 * .exe on Windows.
 */
export function chooseProgram(title: string, mac: boolean): Promise<string | null> {
  return chooseFile(title, {
    defaultPath: mac ? '/Applications' : undefined,
    filters: [{ name: 'Programme', extensions: [mac ? 'app' : 'exe'] }],
  });
}

/** Where to save a new file; `defaultPath` proposes its name (or a full path). */
export async function chooseSaveTarget(
  title: string,
  defaultPath?: string,
  filters?: DialogFilter[],
): Promise<string | null> {
  const picked = await save({ title, defaultPath, filters });
  return picked === null ? null : backend.pathToUi(picked);
}
