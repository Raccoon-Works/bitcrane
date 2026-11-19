/**
 * Watch templates: the built-in starting points for what a watch does not upload, and the user's
 * own templates (settings.watchTemplates) with excludes and options. Own templates are identified
 * by their name, which is unique within the list. The list operations are pure, so they are
 * tested apart from the store (watchTemplates.test.ts).
 */
import { $t } from '../i18n';
import type { WatchTemplate } from './appState';
import { getState } from './core';
import { openDialog } from './panels';
import { updateSettings } from './settings';
import { newWatchOptions } from './watches';

/** A read-only template that only fills in the excludes; ids are stable, labels are translated. */
export interface BuiltinWatchTemplate {
  id: string;
  label: string;
  excludes: string[];
}

/**
 * Kept to project kinds that are common for upload-on-save work. Editor folders and the
 * system's own files (macOS .DS_Store, Windows Thumbs.db) never belong on a server.
 */
export const BUILTIN_WATCH_TEMPLATES: BuiltinWatchTemplate[] = [
  {
    id: 'web',
    label: $t('Web-Projekt'),
    excludes: ['.git', 'node_modules', '.cache', '.idea', '.vscode', '.DS_Store', 'Thumbs.db', '*.log'],
  },
  {
    id: 'python',
    label: $t('Python-Projekt'),
    excludes: [
      '.git',
      '__pycache__',
      '.venv',
      'venv',
      '.pytest_cache',
      '.mypy_cache',
      '.idea',
      '.vscode',
      '.DS_Store',
      'Thumbs.db',
      '*.log',
      '*.tmp',
    ],
  },
];

/** Whether another template than `except` already uses the name (compared trimmed). */
export function templateNameTaken(list: WatchTemplate[], name: string, except?: string): boolean {
  return list.some((t) => t.name !== except && t.name === name.trim());
}

/**
 * Saves a template: it takes the place of the one called `previousName` (a rename or an edit keeps
 * its position, saving under an existing name overwrites it), otherwise it is added at the end.
 */
export function putTemplate(list: WatchTemplate[], tpl: WatchTemplate, previousName = tpl.name): WatchTemplate[] {
  return list.some((t) => t.name === previousName)
    ? list.map((t) => (t.name === previousName ? tpl : t))
    : [...list, tpl];
}

export function removeTemplate(list: WatchTemplate[], name: string): WatchTemplate[] {
  return list.filter((t) => t.name !== name);
}

/** `base`, or "base 2", "base 3" … when that name is taken. */
export function uniqueTemplateName(list: WatchTemplate[], base: string): string {
  let name = base;
  for (let n = 2; templateNameTaken(list, name); n++) name = `${base} ${n}`;
  return name;
}

export function saveWatchTemplate(tpl: WatchTemplate, previousName?: string) {
  updateSettings({ watchTemplates: putTemplate(getState().settings.watchTemplates, tpl, previousName) });
}

export function askDeleteWatchTemplate(name: string) {
  openDialog({
    type: 'confirm',
    danger: true,
    confirm: $t('Löschen'),
    title: $t('Vorlage „{0}“ löschen?', name),
    text: $t('Bestehende Überwachungen bleiben, wie sie sind.'),
    run: () => updateSettings({ watchTemplates: removeTemplate(getState().settings.watchTemplates, name) }),
  });
}

/** "Als eigene Vorlage übernehmen": copies a built-in template with the default options and opens it for editing. */
export function adoptBuiltinTemplate(builtin: BuiltinWatchTemplate) {
  const list = getState().settings.watchTemplates;
  const name = uniqueTemplateName(list, builtin.label);
  updateSettings({
    watchTemplates: [...list, { name, excludes: [...builtin.excludes], options: newWatchOptions() }],
  });
  openDialog({ type: 'watchTemplate', name });
}
