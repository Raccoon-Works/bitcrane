/**
 * Settings › Terminal › Snippets: saved commands for the terminal, in groups
 * (like the Quick Commands of Tabby). Rows are moved by dragging the handle
 * (pointer events: HTML drag and drop is taken by the file drop of the window),
 * also into another group; the eye hides a snippet or a whole group from the
 * snippet menu without deleting it. "Aus Tabby übernehmen" reads Tabby's
 * quick commands (state/terminal.ts).
 */
import { useState, type PointerEvent as ReactPointerEvent } from 'react';
import { $t } from '../../i18n';
import { getState, showToast, uid, updateSettings, useStore } from '../../state/store';
import { importTabbySnippets, type Snippet } from '../../state/terminal';
import { Eye, EyeOff, GripVertical, Plus, X } from '../glyphs';
import { Button, IconButton, Switch, TextField } from '../ui';

const NO_SNIPPETS: Snippet[] = [];
const NO_GROUPS: string[] = [];
const getSnippets = () => getState().settings.snippets ?? NO_SNIPPETS;

/** Snippets without a group come first; then the groups in their saved order. */
function groupsOf(snippets: Snippet[], order: string[]): string[] {
  const out = [...order];
  for (const s of snippets) if (s.group && !out.includes(s.group)) out.push(s.group);
  return out;
}

export function SnippetSettings() {
  const snippets = useStore((s) => s.settings.snippets) ?? NO_SNIPPETS;
  const order = useStore((s) => s.settings.snippetGroups) ?? NO_GROUPS;
  const groups = groupsOf(snippets, order);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [newGroup, setNewGroup] = useState<string | null>(null);

  const save = (list: Snippet[], g: string[] = groups) => updateSettings({ snippets: list, snippetGroups: g });
  const edit = (id: string, patch: Partial<Snippet>) => save(snippets.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const add = (group?: string) => save([...snippets, { id: uid('sn'), name: '', command: '', run: true, group }]);

  /** Drops the dragged snippet before `beforeId`, or at the end of `group`. */
  const dropAt = (id: string, group: string | undefined, beforeId?: string) => {
    const all = getSnippets();
    const moving = all.find((x) => x.id === id);
    if (!moving || moving.id === beforeId) return;
    const rest = all.filter((x) => x.id !== moving.id);
    const moved = { ...moving, group };
    let at = beforeId ? rest.findIndex((x) => x.id === beforeId) : -1;
    if (at < 0) {
      // End of the group: after its last member, or at the end of the list.
      const last = rest.map((x) => x.group).lastIndexOf(group);
      at = last >= 0 ? last + 1 : rest.length;
    }
    updateSettings({ snippets: [...rest.slice(0, at), moved, ...rest.slice(at)], snippetGroups: groupsOf(all, getState().settings.snippetGroups ?? []) });
  };
  /** Dragging by the handle: the row or group head under the pointer is the target. */
  const begin = (e: ReactPointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.preventDefault();
    setDragId(id);
    let target: { group: string | undefined; before?: string; key: string } | null = null;
    const move = (ev: PointerEvent) => {
      const el = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-snippet-id], [data-snippet-group]');
      if (!el) { target = null; setOver(null); return; }
      if (el.dataset.snippetId) {
        const sn = getSnippets().find((x) => x.id === el.dataset.snippetId);
        target = { group: sn?.group, before: el.dataset.snippetId, key: el.dataset.snippetId };
      } else {
        const g = el.dataset.snippetGroup ?? '';
        target = { group: g || undefined, key: g ? `g:${g}` : '' };
      }
      setOver(target.key);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('is-dragging-snippet');
      if (target) dropAt(id, target.group, target.before);
      setDragId(null);
      setOver(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.body.classList.add('is-dragging-snippet');
  };

  const renameGroup = (from: string, to: string) => {
    const name = to.trim();
    if (!name || name === from || groups.includes(name)) return;
    save(snippets.map((x) => (x.group === from ? { ...x, group: name } : x)), groups.map((g) => (g === from ? name : g)));
  };
  const removeGroup = (g: string) => save(snippets.map((x) => (x.group === g ? { ...x, group: undefined } : x)), groups.filter((x) => x !== g));
  const groupHidden = (g: string) => snippets.some((x) => x.group === g) && snippets.filter((x) => x.group === g).every((x) => x.hidden);
  const setGroupHidden = (g: string, hidden: boolean) => save(snippets.map((x) => (x.group === g ? { ...x, hidden: hidden || undefined } : x)));
  const moveGroup = (g: string, d: -1 | 1) => {
    const i = groups.indexOf(g);
    const j = i + d;
    if (j < 0 || j >= groups.length) return;
    const next = [...groups];
    [next[i], next[j]] = [next[j], next[i]];
    save(snippets, next);
  };

  const fromTabby = async () => {
    const n = await importTabbySnippets();
    if (n === null) showToast($t('In Tabby wurden keine Quick Commands gefunden.'));
    else showToast(n ? $t('{0} Befehle aus Tabby übernommen.', String(n)) : $t('Die Befehle aus Tabby sind schon alle da.'), n ? 'ok' : 'info');
  };

  const row = (sn: Snippet) => (
    <div key={sn.id} className={`set-row snippet-row${sn.hidden ? ' is-hidden' : ''}${over === sn.id ? ' is-drop' : ''}${dragId === sn.id ? ' is-dragging' : ''}`}
      data-snippet-id={sn.id}>
      <span className="snippet-grip" aria-label={$t('Ziehen zum Verschieben')} title={$t('Ziehen zum Verschieben')} onPointerDown={(e) => begin(e, sn.id)}>
        <GripVertical size={14} />
      </span>
      <TextField value={sn.name} onChange={(v) => edit(sn.id, { name: v })} placeholder={$t('Name')} label={$t('Name')} className="snippet-name" />
      <TextField value={sn.command} onChange={(v) => edit(sn.id, { command: v })} placeholder={$t('Befehl')} label={$t('Befehl')} mono className="flex-1" />
      <span className="row-inline small" title={$t('Nach dem Einfügen gleich ausführen')}><Switch checked={sn.run} onChange={(v) => edit(sn.id, { run: v })} label={$t('Gleich ausführen')} />{$t('ausführen')}</span>
      <IconButton label={sn.hidden ? $t('Im Menü zeigen') : $t('Im Menü ausblenden')} onClick={() => edit(sn.id, { hidden: !sn.hidden || undefined })}>
        {sn.hidden ? <EyeOff size={15} /> : <Eye size={15} />}
      </IconButton>
      <IconButton label={$t('Entfernen')} onClick={() => save(snippets.filter((x) => x.id !== sn.id))}><X size={14} strokeWidth={1.75} /></IconButton>
    </div>
  );

  const loose = snippets.filter((x) => !x.group);
  return (
    <>
      {/* Also the drop place for "no group". */}
      <div className={`set-row${over === '' ? ' is-drop' : ''}`} data-snippet-group="">
        <span className="small muted flex-1">
          {$t('Gespeicherte Befehle, die du im Terminal über das {}-Symbol mit einem Klick einfügst. Am Griff ziehen ordnet sie um, auch in eine andere Gruppe. \\x03 sendet Strg+C, \\s500 wartet eine halbe Sekunde.')}
        </span>
      </div>
      {loose.map(row)}
      {groups.map((g, i) => {
        const members = snippets.filter((x) => x.group === g);
        const hidden = groupHidden(g);
        return (
          <div key={g} className="snippet-group">
            <div className={`set-row snippet-group-head${over === `g:${g}` ? ' is-drop' : ''}${hidden ? ' is-hidden' : ''}`} data-snippet-group={g}>
              <GroupName name={g} onRename={(to) => renameGroup(g, to)} />
              <span className="small muted flex-1">{members.length === 1 ? $t('1 Befehl') : $t('{0} Befehle', String(members.length))}</span>
              <IconButton label={$t('Gruppe nach oben')} disabled={i === 0} onClick={() => moveGroup(g, -1)}><span aria-hidden="true">↑</span></IconButton>
              <IconButton label={$t('Gruppe nach unten')} disabled={i === groups.length - 1} onClick={() => moveGroup(g, 1)}><span aria-hidden="true">↓</span></IconButton>
              <IconButton label={hidden ? $t('Gruppe im Menü zeigen') : $t('Gruppe im Menü ausblenden')} disabled={!members.length} onClick={() => setGroupHidden(g, !hidden)}>
                {hidden ? <EyeOff size={15} /> : <Eye size={15} />}
              </IconButton>
              <IconButton label={$t('Gruppe auflösen (die Befehle bleiben)')} onClick={() => removeGroup(g)}><X size={14} strokeWidth={1.75} /></IconButton>
            </div>
            {members.map(row)}
            <div className="set-row snippet-add-in"><Button small variant="ghost" onClick={() => add(g)}><Plus size={13} strokeWidth={2} /> {$t('Befehl in „{0}“', g)}</Button></div>
          </div>
        );
      })}
      <div className="set-row">
        <Button small onClick={() => add()}><Plus size={13} strokeWidth={2} /> {$t('Snippet hinzufügen')}</Button>
        {newGroup === null
          ? <Button small onClick={() => setNewGroup('')}><Plus size={13} strokeWidth={2} /> {$t('Gruppe')}</Button>
          : (
            <span className="row-inline">
              <TextField value={newGroup} onChange={setNewGroup} placeholder={$t('Name der Gruppe')} label={$t('Name der Gruppe')} autoFocus
                onEnter={() => { const n = newGroup.trim(); if (n && !groups.includes(n)) save(snippets, [...groups, n]); setNewGroup(null); }} />
              <Button small variant="ghost" onClick={() => setNewGroup(null)}>{$t('Abbrechen')}</Button>
            </span>
          )}
        <span className="flex-1" />
        <Button small variant="ghost" onClick={() => void fromTabby()}>{$t('Aus Tabby übernehmen …')}</Button>
      </div>
    </>
  );
}

/** Group name, renamed by clicking it. */
function GroupName({ name, onRename }: { name: string; onRename: (to: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  if (draft === null) {
    return <button type="button" className="snippet-group-name" title={$t('Klicken zum Umbenennen')} onClick={() => setDraft(name)}>{name}</button>;
  }
  return <TextField value={draft} onChange={setDraft} label={$t('Name der Gruppe')} autoFocus onEnter={() => { onRename(draft); setDraft(null); }} className="snippet-group-edit" />;
}
