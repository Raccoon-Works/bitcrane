import { describe, expect, it } from 'vitest';
import type { WatchTemplate } from './appState';
import { defaultWatchOptions } from './defaults';
import {
  BUILTIN_WATCH_TEMPLATES,
  putTemplate,
  removeTemplate,
  templateNameTaken,
  uniqueTemplateName,
} from './watchTemplates';

const tpl = (name: string, excludes: string[] = []): WatchTemplate => ({
  name,
  excludes,
  options: defaultWatchOptions,
});
const names = (list: WatchTemplate[]) => list.map((t) => t.name);
const LIST = [tpl('Bot', ['.git']), tpl('Webseite', ['node_modules']), tpl('Plugin')];

describe('templateNameTaken', () => {
  it('finds a name used by another template, compared trimmed', () => {
    expect(templateNameTaken(LIST, 'Bot')).toBe(true);
    expect(templateNameTaken(LIST, '  Bot ')).toBe(true);
    expect(templateNameTaken(LIST, 'Neu')).toBe(false);
  });

  it('ignores the template being renamed', () => {
    expect(templateNameTaken(LIST, 'Bot', 'Bot')).toBe(false);
    expect(templateNameTaken(LIST, 'Webseite', 'Bot')).toBe(true);
  });
});

describe('putTemplate', () => {
  it('adds a new template at the end', () => {
    expect(names(putTemplate(LIST, tpl('Neu')))).toEqual(['Bot', 'Webseite', 'Plugin', 'Neu']);
  });

  it('overwrites a template of the same name in place', () => {
    const out = putTemplate(LIST, tpl('Webseite', ['dist']));
    expect(names(out)).toEqual(['Bot', 'Webseite', 'Plugin']);
    expect(out[1].excludes).toEqual(['dist']);
  });

  it('renames in place and keeps the contents', () => {
    const out = putTemplate(LIST, { ...LIST[0], name: 'Discord-Bot' }, 'Bot');
    expect(names(out)).toEqual(['Discord-Bot', 'Webseite', 'Plugin']);
    expect(out[0].excludes).toEqual(['.git']);
  });

  it('leaves the original list unchanged', () => {
    putTemplate(LIST, tpl('Bot', ['x']));
    expect(LIST[0].excludes).toEqual(['.git']);
  });
});

describe('removeTemplate', () => {
  it('removes only the named template', () => {
    expect(names(removeTemplate(LIST, 'Webseite'))).toEqual(['Bot', 'Plugin']);
    expect(names(removeTemplate(LIST, 'Gibt es nicht'))).toEqual(['Bot', 'Webseite', 'Plugin']);
  });
});

describe('uniqueTemplateName', () => {
  it('keeps a free name and counts up a taken one', () => {
    expect(uniqueTemplateName(LIST, 'Neu')).toBe('Neu');
    expect(uniqueTemplateName(LIST, 'Bot')).toBe('Bot 2');
    expect(uniqueTemplateName([...LIST, tpl('Bot 2')], 'Bot')).toBe('Bot 3');
  });
});

describe('BUILTIN_WATCH_TEMPLATES', () => {
  it('has unique ids and no repeated pattern', () => {
    expect(new Set(BUILTIN_WATCH_TEMPLATES.map((b) => b.id)).size).toBe(BUILTIN_WATCH_TEMPLATES.length);
    for (const b of BUILTIN_WATCH_TEMPLATES) expect(new Set(b.excludes).size).toBe(b.excludes.length);
  });

  it('uses only pattern forms the exclude matching understands (a name or "*.ext")', () => {
    for (const b of BUILTIN_WATCH_TEMPLATES) for (const p of b.excludes) expect(p).toMatch(/^(\*\.[^*/]+|[^*/]+)$/);
  });
});
