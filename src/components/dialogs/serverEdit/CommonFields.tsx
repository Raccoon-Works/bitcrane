/**
 * Server editor fields below the login: start folders, jump server and what a
 * double click opens (SFTP), the group and the transfer rule.
 */
import type { Server } from '../../../backend/types';
import { NO_RULES, useStore } from '../../../state/store';
import { Segmented, Select, TextField } from '../../ui';
import { $t } from '../../../i18n';
import type { Fam, SetField } from './model';

export function CommonFields({
  draft,
  set,
  family,
  servers,
}: {
  draft: Server;
  set: SetField;
  family: Fam;
  servers: Server[];
}) {
  const rules = useStore((s) => s.settings.rules) ?? NO_RULES;
  return (
    <>
      <span>{$t('Startordner')}</span>
      <div className="sub-grid">
        <span className="small muted">{$t('Lokal')}</span>
        <TextField mono value={draft.localStart} onChange={(v) => set('localStart', v)} />
        <span className="small muted">{$t('Server')}</span>
        <TextField
          mono
          value={draft.remoteStart}
          onChange={(v) => set('remoteStart', v)}
          placeholder={family === 'cloud' || family === 's3' ? '/' : `/home/${draft.user || 'benutzer'}`}
        />
      </div>

      {family === 'sftp' && (
        <>
          <label htmlFor="s-jump">{$t('Sprungserver')}</label>
          <div className="col-text">
            <Select
              id="s-jump"
              label={$t('Sprungserver')}
              value={draft.jumpServerId ?? ''}
              onChange={(v) => set('jumpServerId', v || undefined)}
              options={[
                { value: '', label: $t('Keiner, direkt verbinden') },
                ...servers
                  .filter((x) => x.id !== draft.id)
                  .map((x) => ({ value: x.id, label: $t('Über {0}', x.name) })),
              ]}
            />
            <span className="small muted">
              {$t(
                'Für Server, die nur über einen anderen Server erreichbar sind (wie ProxyJump in der SSH-Konfiguration).',
              )}
            </span>
          </div>

          <span>{$t('Beim Öffnen')}</span>
          <div className="col-text">
            <div className="row-inline">
              <Segmented<'files' | 'terminal'>
                label={$t('Beim Öffnen')}
                value={draft.openAs ?? 'files'}
                onChange={(v) => set('openAs', v === 'terminal' ? 'terminal' : undefined)}
                options={[
                  { value: 'files', label: $t('Dateien') },
                  { value: 'terminal', label: $t('Nur Terminal') },
                ]}
              />
            </div>
            <span className="small muted">
              {draft.openAs === 'terminal'
                ? $t(
                    'Ein Doppelklick öffnet eine SSH-Konsole im eigenen Tab. Die Dateien erreichst du per Rechtsklick › Dateien öffnen.',
                  )
                : $t(
                    'Derselbe Server kann beides: Dateien hier, SSH-Terminal über den Terminal-Knopf oder per Rechtsklick.',
                  )}
            </span>
          </div>
        </>
      )}

      <label htmlFor="s-group">{$t('Gruppe')}</label>
      <TextField
        id="s-group"
        value={draft.group}
        onChange={(v) => set('group', v)}
        placeholder={$t('z. B. Kunden')}
        className="group-field"
      />

      {/* Transfer rule for this server's manual transfers and watches (settings > Regeln). */}
      <label htmlFor="s-rule">{$t('Regel')}</label>
      <div className="col-text">
        <Select
          id="s-rule"
          label={$t('Regel')}
          value={draft.ruleId ?? ''}
          onChange={(v) => set('ruleId', v || undefined)}
          options={[
            { value: '', label: $t('Keine, allgemeine Einstellungen') },
            ...rules.map((r) => ({ value: r.id, label: r.name || $t('Ohne Namen') })),
          ]}
        />
        <span className="small muted">{$t('Regeln legst du unter Einstellungen › Regeln an.')}</span>
      </div>
    </>
  );
}
