/**
 * Permissions of a file or folder: the read/write/execute grid, the octal
 * number and, for folders, applying them to everything inside.
 */
import { useState } from 'react';
import type { PaneSide } from '../../backend/types';
import { activeTab, closeDialog, LIVE, paneLoc, paneOnServer, savePerms, statEntry, useStore } from '../../state/store';
import { permsToText } from '../../util/format';
import { Info } from '../glyphs';
import { FileGlyph, FolderGlyph } from '../icons';
import { Button, Checkbox, TextField } from '../ui';
import { Dialog } from './Dialog';
import { $t } from '../../i18n';

export function PermsDialog({ side, path }: { side: PaneSide; path: string }) {
  const tab = useStore((s) => activeTab(s));
  const entry = tab ? statEntry(...paneLoc(side, tab), path) : undefined;
  const [perms, setPerms] = useState(entry?.perms ?? '644');
  const [owner, setOwner] = useState(entry?.owner ?? '');
  const [group, setGroup] = useState(entry?.group ?? '');
  const [recursive, setRecursive] = useState(entry?.kind === 'dir');
  if (!entry || !tab) return null;
  const digits = perms
    .padEnd(3, '0')
    .slice(0, 3)
    .split('')
    .map((d) => Number(d) || 0);
  const toggle = (r: number, c: number) => {
    const mask = [4, 2, 1][c];
    setPerms(digits.map((v, i) => (i === r ? v ^ mask : v)).join(''));
  };
  const valid = /^[0-7]{3}$/.test(perms);
  const fileVariant = perms.replace(/[1357]/g, (c) => String(Number(c) - 1));
  return (
    <Dialog
      label={$t('Rechte ändern')}
      title={$t('Rechte für „{0}“', entry.name)}
      subtitle={<span className="mono small">{path}</span>}
      icon={entry.kind === 'dir' ? <FolderGlyph size={36} /> : <FileGlyph size={32} />}
      width={540}
      footer={
        <>
          <span className="flex-1" />
          <Button onClick={closeDialog}>{$t('Abbrechen')}</Button>
          <Button
            variant="primary"
            disabled={!valid}
            onClick={() => savePerms(side, path, perms, owner, group, recursive && entry.kind === 'dir')}
          >
            {$t('Übernehmen')}
          </Button>
        </>
      }
    >
      <div className="form-stack">
        <div className="two-fields">
          {LIVE ? (
            <>
              <span>{$t('Besitzer')}</span>
              <span className="mono">{owner || '–'}</span>
              <span>{$t('Gruppe')}</span>
              <span className="mono">{group || '–'}</span>
              <span />
              <span className="small muted">
                {$t(
                  'Den Besitzer zu ändern braucht Administratorrechte auf dem Server (sudo chown); Bitcrane ändert nur die Rechte.',
                )}
              </span>
            </>
          ) : (
            <>
              <label htmlFor="p-owner">{$t('Besitzer')}</label>
              <TextField id="p-owner" value={owner} onChange={setOwner} />
              <label htmlFor="p-group">{$t('Gruppe')}</label>
              <TextField id="p-group" value={group} onChange={setGroup} />
            </>
          )}
        </div>
        {paneOnServer(side, tab) && (
          <div className="notice tone-info-notice">
            <Info size={14} strokeWidth={1.75} aria-hidden="true" />
            {$t('Besitzer und Gruppe kann nur ändern, wer auf dem Server Administratorrechte hat.')}
          </div>
        )}
        <table className="perm-table">
          <thead>
            <tr>
              <th scope="col">
                <span className="vh">{$t('Wer')}</span>
              </th>
              <th scope="col">{$t('Lesen')}</th>
              <th scope="col">{$t('Schreiben')}</th>
              <th scope="col">{$t('Ausführen')}</th>
            </tr>
          </thead>
          <tbody>
            {[$t('Besitzer'), $t('Gruppe'), $t('Andere')].map((w, r) => (
              <tr key={w}>
                <th scope="row">{w}</th>
                {[$t('lesen'), $t('schreiben'), $t('ausführen')].map((x, c) => {
                  const on = (digits[r] & [4, 2, 1][c]) !== 0;
                  return (
                    <td key={x}>
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={on}
                        aria-label={`${w} ${x}`}
                        className="perm-hit"
                        onClick={() => toggle(r, c)}
                      >
                        <span className={`checkbox-box${on ? ' is-on' : ''}`}>
                          {on && (
                            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="2.6">
                              <path d="m3.5 8.5 3 3 6-7" />
                            </svg>
                          )}
                        </span>
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row-inline">
          <label htmlFor="p-oct" className="muted">
            {$t('Als Zahl')}
          </label>
          <TextField
            id="p-oct"
            mono
            value={perms}
            onChange={(v) => setPerms(v.replace(/[^0-7]/g, '').slice(0, 3))}
            invalid={!valid}
            className="oct-field"
          />
          <span className="mono small muted">{valid ? permsToText(perms) : $t('drei Ziffern 0 bis 7')}</span>
        </div>
        {entry.kind === 'dir' && (
          <Checkbox
            checked={recursive}
            onChange={setRecursive}
            label={$t('Auch auf alle Unterordner und Dateien anwenden')}
            note={$t('Dateien bekommen dabei {0} statt {1}, damit sie nicht ausführbar werden.', fileVariant, perms)}
          />
        )}
      </div>
    </Dialog>
  );
}
