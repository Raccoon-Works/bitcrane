/**
 * Settings › Regeln: named transfer rules (like WinSCP's transfer presets). A
 * server uses one for its manual transfers and watches; a watch can choose
 * another. Empty fields keep the general settings of "Übertragungen".
 */
import { useState } from 'react';
import { Plus } from '../../glyphs';
import {
  getState,
  newRuleId,
  NO_RULES,
  removeRule,
  saveRule,
  useStore,
  type ExistingRule,
  type TransferRule,
} from '../../../state/store';
import { Button, Select, Switch, TextField } from '../../ui';
import { $t } from '../../../i18n';
import { existingOptions, permOptions } from './options';
import { Chips, Group, Row } from './parts';

export function RulesSettings() {
  const rules = useStore((st) => st.settings.rules) ?? NO_RULES;
  const servers = useStore((st) => st.servers);
  const watches = useStore((st) => st.watches);
  const [selId, setSelId] = useState<string | null>(rules[0]?.id ?? null);
  const sel = rules.find((r) => r.id === selId) ?? rules[0];
  const add = (from?: TransferRule) => {
    const r: TransferRule = from
      ? { ...from, id: newRuleId(), name: $t('{0} (Kopie)', from.name), excludes: [...from.excludes] }
      : { id: newRuleId(), name: $t('Neue Regel'), excludes: ['.git', '__pycache__', '*.log'] };
    saveRule(r);
    setSelId(r.id);
  };
  const set = <K extends keyof TransferRule>(k: K, v: TransferRule[K]) => {
    if (sel) saveRule({ ...sel, [k]: v });
  };
  const usedBy = sel
    ? [
        ...servers.filter((x) => x.ruleId === sel.id).map((x) => x.name),
        ...watches.filter((w) => w.ruleId === sel.id).map((w) => w.name),
      ]
    : [];
  const inherit = (label: string) => [{ value: '', label: $t('Wie allgemein eingestellt ({0})', label) }];
  const existingLabel = (v: ExistingRule) => existingOptions.find((o) => o.value === v)?.label ?? v;
  const gs = getState().settings;
  return (
    <>
      <p className="small muted">
        {$t(
          'Eine Regel bündelt Einstellungen fürs Übertragen und gilt für einen Server (Server bearbeiten › Regel) oder eine Überwachung. Leere Felder nehmen die allgemeinen Einstellungen.',
        )}
      </p>
      {sel ? (
        <div className="rules-layout">
          <div className="rules-list" role="listbox" aria-label={$t('Regeln')}>
            {rules.map((r) => (
              <button
                key={r.id}
                type="button"
                role="option"
                aria-selected={r.id === sel.id}
                className={`rules-item${r.id === sel.id ? ' is-sel' : ''}`}
                onClick={() => setSelId(r.id)}
              >
                {r.name || $t('Ohne Namen')}
              </button>
            ))}
            <span className="row-inline rules-buttons">
              <Button small onClick={() => add()}>
                {$t('Neue Regel')}
              </Button>
              <Button small onClick={() => add(sel)}>
                {$t('Duplizieren')}
              </Button>
            </span>
          </div>
          <div className="rules-detail">
            <Group title={$t('Regel')}>
              <Row label={$t('Name')}>
                <TextField
                  label={$t('Name der Regel')}
                  value={sel.name}
                  onChange={(v) => set('name', v)}
                  placeholder={$t('z. B. Bot oder Webseite')}
                />
              </Row>
              <Row
                label={$t('Verwendet von')}
                note={usedBy.length ? usedBy.join(', ') : $t('Noch von keinem Server und keiner Überwachung.')}
              />
            </Group>
            <Group title={$t('Nie übertragen')}>
              <Row
                label={$t('Namen und Muster')}
                note={$t('Kommt zu den allgemeinen Mustern und denen der Überwachung dazu.')}
                column
              >
                <Chips values={sel.excludes} onChange={(v) => set('excludes', v)} placeholder="venv" />
              </Row>
              <Row label={$t('Größere Dateien auslassen')}>
                <Select
                  value={sel.skipLargerMb === undefined ? '' : String(sel.skipLargerMb)}
                  onChange={(v) => set('skipLargerMb', v === '' ? undefined : Number(v))}
                  label={$t('Größere Dateien auslassen')}
                  options={[
                    ...inherit(gs.skipLargerMb ? `${gs.skipLargerMb} MB` : $t('keine Grenze')),
                    { value: '0', label: $t('Keine Grenze') },
                    ...[10, 50, 100, 500, 1024].map((n) => ({
                      value: String(n),
                      label: n >= 1024 ? '1 GB' : `${n} MB`,
                    })),
                  ]}
                />
              </Row>
            </Group>
            <Group title={$t('Wenn die Datei schon da ist')}>
              <Row label={$t('Beim Hochladen')}>
                <Select
                  value={sel.existingUp ?? ''}
                  onChange={(v) => set('existingUp', (v || undefined) as ExistingRule | undefined)}
                  label={$t('Beim Hochladen')}
                  options={[...inherit(existingLabel(gs.existingFiles)), ...existingOptions]}
                />
              </Row>
              <Row label={$t('Beim Herunterladen')}>
                <Select
                  value={sel.existingDown ?? ''}
                  onChange={(v) => set('existingDown', (v || undefined) as ExistingRule | undefined)}
                  label={$t('Beim Herunterladen')}
                  options={[...inherit(existingLabel(gs.existingDownload)), ...existingOptions]}
                />
              </Row>
              <Row
                label={$t('Ältere Version auf dem Server behalten')}
                note={$t('Vor dem Ersetzen wird die alte Datei gesichert (bis zu 5 Versionen).')}
              >
                <Switch
                  checked={!!sel.keepOldVersion}
                  onChange={(v) => set('keepOldVersion', v)}
                  label={$t('Ältere Version behalten')}
                />
              </Row>
            </Group>
            <Group title={$t('Rechte beim Hochladen')}>
              <Row label={$t('Dateien')}>
                <Select
                  value={sel.filePerms ?? ''}
                  onChange={(v) => set('filePerms', v || undefined)}
                  label={$t('Rechte für Dateien')}
                  options={permOptions(['644', '664', '600', '640', '755'])}
                />
              </Row>
              <Row label={$t('Ordner')}>
                <Select
                  value={sel.dirPerms ?? ''}
                  onChange={(v) => set('dirPerms', v || undefined)}
                  label={$t('Rechte für Ordner')}
                  options={permOptions(['755', '775', '700', '750'], true)}
                />
              </Row>
            </Group>
            <span className="row-inline">
              <span className="flex-1" />
              <Button
                small
                variant="danger"
                onClick={() => {
                  removeRule(sel.id);
                  setSelId(null);
                }}
              >
                {$t('Regel löschen')}
              </Button>
            </span>
          </div>
        </div>
      ) : (
        <div className="set-card">
          <Row
            label={$t('Noch keine Regel')}
            note={$t(
              'Zum Beispiel „Bot“: .git, __pycache__ und *.log nie hochladen, Rechte 644/755. Danach unter Server bearbeiten › Regel auswählen.',
            )}
          >
            <Button small onClick={() => add()}>
              <Plus size={13} strokeWidth={2} /> {$t('Erste Regel anlegen')}
            </Button>
          </Row>
        </div>
      )}
    </>
  );
}
