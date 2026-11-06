import { beforeEach, describe, expect, it } from 'vitest';
import type { Snippet } from './terminal';
import { candidatesFor, clearHistory, historyCount, rememberCommand, wantsPath } from './termSuggest';

describe('wantsPath', () => {
  it('expects a path after file commands, also behind sudo', () => {
    expect(wantsPath('cd ')).toBe(true);
    expect(wantsPath('vim conf')).toBe(true);
    expect(wantsPath('sudo nano conf')).toBe(true);
  });

  it('expects a path for words that look like one', () => {
    expect(wantsPath('./scr')).toBe(true);
    expect(wantsPath('~/')).toBe(true);
    expect(wantsPath('git add src/a')).toBe(true);
  });

  it('expects a command for the first word and after other commands', () => {
    expect(wantsPath('ls')).toBe(false);
    expect(wantsPath('echo hello')).toBe(false);
  });
});

describe('candidatesFor', () => {
  beforeEach(() => clearHistory());

  const snippet = (name: string, command: string): Snippet => ({ id: name, name, command, run: false });

  it('suggests nothing for an empty line', () => {
    expect(candidatesFor('srv-1', '  ', [snippet('a', 'ls')], ['a/'])).toEqual([]);
  });

  it('completes the word being typed from the folder listing', () => {
    const names = ['src/', 'static/', '.ssh/', 'setup.py', 's'];
    expect(candidatesFor('srv-1', 'cd s', [], names).slice(0, 3)).toEqual([
      { text: 'cd src/', kind: 'folder', label: 'src/' },
      { text: 'cd static/', kind: 'folder', label: 'static/' },
      { text: 'cd setup.py', kind: 'file', label: 'setup.py' },
    ]);
  });

  it('leaves hidden names out until a dot is typed', () => {
    const names = ['.ssh/', 'src/'];
    const listed = (input: string) =>
      candidatesFor('srv-1', input, [], names)
        .filter((c) => c.kind === 'folder')
        .map((c) => c.text);
    expect(listed('cd ')).toEqual(['cd src/']);
    expect(listed('cd .')).toEqual(['cd .ssh/']);
  });

  it('puts history before snippets and common commands, without duplicates', () => {
    rememberCommand('srv-1', 'tail -f /var/log/app.log');
    const out = candidatesFor(
      'srv-1',
      'tail',
      [snippet('Logs', 'tail -f /var/log/app.log'), snippet('', 'tail -n 50 x')],
      null,
    );
    expect(out.slice(0, 2)).toEqual([
      { text: 'tail -f /var/log/app.log', kind: 'history' },
      { text: 'tail -n 50 x', kind: 'snippet', label: undefined },
    ]);
    expect(out.slice(2).every((c) => c.kind === 'command' && c.text.startsWith('tail'))).toBe(true);
  });

  it('never suggests the typed line itself and shows at most eight', () => {
    rememberCommand('srv-1', 'ls');
    expect(candidatesFor('srv-1', 'ls', [], null).some((c) => c.text === 'ls')).toBe(false);
    expect(candidatesFor('srv-1', 't', [], null)).toHaveLength(8);
  });
});

describe('history', () => {
  beforeEach(() => clearHistory());

  const history = (serverId: string, input: string) =>
    candidatesFor(serverId, input, [], null)
      .filter((c) => c.kind === 'history')
      .map((c) => c.text);

  it('keeps commands per server, newest first, and moves repeats up', () => {
    rememberCommand('srv-1', 'deploy.sh one');
    rememberCommand('srv-1', 'deploy.sh two');
    rememberCommand('srv-1', 'deploy.sh one');
    rememberCommand('', 'deploy.sh local');
    expect(history('srv-1', 'deploy')).toEqual(['deploy.sh one', 'deploy.sh two']);
    expect(history('', 'deploy')).toEqual(['deploy.sh local']);
    expect(historyCount()).toBe(3);
  });

  it('ignores empty lines and lines starting with a space', () => {
    rememberCommand('srv-1', '   ');
    rememberCommand('srv-1', ' export TOKEN=secret');
    expect(historyCount()).toBe(0);
  });

  it('forgets everything on clear', () => {
    rememberCommand('srv-1', 'uptime');
    clearHistory();
    expect(historyCount()).toBe(0);
    expect(history('srv-1', 'up')).toEqual([]);
  });
});
