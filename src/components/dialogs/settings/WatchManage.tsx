/**
 * Settings › Überwachung: the list of watches and of watch templates. The actions on a watch are
 * the ones of the watch popover; a template is edited in its own dialog (WatchTemplateEdit).
 */
import { useState } from 'react';
import type { WatchTemplate } from '../../../state/store';
import {
  adoptBuiltinTemplate,
  askDeleteWatchTemplate,
  BUILTIN_WATCH_TEMPLATES,
  openDialog,
  saveWatchTemplate,
  templateNameTaken,
  useStore,
  watchRoute,
  watchStatus,
} from '../../../state/store';
import { WatchActions } from '../../WatchPopover';
import { Button, TextField } from '../../ui';
import { $t } from '../../../i18n';
import { Group, Row } from './parts';

export function WatchList() {
  const watches = useStore((s) => s.watches);
  const servers = useStore((s) => s.servers);
  return (
    <Group title={$t('Überwachungen')}>
      {watches.length === 0 ? (
        <Row
          label={$t('Noch keine Überwachung')}
          note={$t('Mit einer Überwachung lädt Bitcrane jede Änderung in einem Ordner automatisch hoch.')}
        >
          <Button small onClick={() => openDialog({ type: 'watchSetup' })}>
            {$t('Neue Überwachung')}
          </Button>
        </Row>
      ) : (
        watches.map((w) => {
          const status = watchStatus(w);
          const route = watchRoute(
            w,
            servers.find((x) => x.id === w.serverId),
          );
          return (
            <div key={w.id} className="set-row">
              <span className={`pill-dot tone-${status.tone}`} />
              <div className="col-text flex-1">
                <span className="ellipsis">{w.name}</span>
                {/* Long folders are cut; the full route shows on hover. */}
                <span className="small muted mono ellipsis" title={route}>
                  {route}
                </span>
              </div>
              <span className={`small tone-${status.tone}`}>{status.text}</span>
              <WatchActions w={w} />
            </div>
          );
        })
      )}
    </Group>
  );
}

export function WatchTemplateList() {
  const templates = useStore((s) => s.settings.watchTemplates);
  const [renaming, setRenaming] = useState<string | null>(null);
  return (
    <>
      <Group title={$t('Eigene Vorlagen')}>
        {templates.length === 0 && (
          <Row
            label={$t('Noch keine eigene Vorlage')}
            note={$t(
              'Im Fenster einer neuen Überwachung „Als Vorlage speichern“ wählen oder unten eine mitgelieferte Vorlage übernehmen.',
            )}
          />
        )}
        {templates.map((t) =>
          renaming === t.name ? (
            <RenameRow key={t.name} template={t} templates={templates} onDone={() => setRenaming(null)} />
          ) : (
            <div key={t.name} className="set-row">
              <div className="col-text flex-1">
                <span className="ellipsis">{t.name}</span>
                <span className="small muted mono ellipsis" title={patternSummary(t.excludes)}>
                  {patternSummary(t.excludes)}
                </span>
              </div>
              <Button small onClick={() => setRenaming(t.name)}>
                {$t('Umbenennen')}
              </Button>
              <Button small onClick={() => openDialog({ type: 'watchTemplate', name: t.name })}>
                {$t('Bearbeiten')}
              </Button>
              <Button small onClick={() => askDeleteWatchTemplate(t.name)}>
                {$t('Löschen')}
              </Button>
            </div>
          ),
        )}
      </Group>
      <Group title={$t('Mitgelieferte Vorlagen')}>
        {BUILTIN_WATCH_TEMPLATES.map((b) => (
          <div key={b.id} className="set-row">
            <div className="col-text flex-1">
              <span className="ellipsis">{b.label}</span>
              <span className="small muted mono ellipsis" title={patternSummary(b.excludes)}>
                {patternSummary(b.excludes)}
              </span>
            </div>
            <Button small onClick={() => adoptBuiltinTemplate(b)}>
              {$t('Als eigene Vorlage übernehmen')}
            </Button>
          </div>
        ))}
      </Group>
    </>
  );
}

/** The patterns a template leaves out, as one line. */
function patternSummary(excludes: string[]): string {
  return excludes.length ? excludes.join(', ') : $t('Lädt alles hoch');
}

/** A template's name as a field; Enter or "Sichern" renames it, Escape or "Abbrechen" keeps the old name. */
function RenameRow({
  template,
  templates,
  onDone,
}: {
  template: WatchTemplate;
  templates: WatchTemplate[];
  onDone: () => void;
}) {
  const [name, setName] = useState(template.name);
  const taken = templateNameTaken(templates, name, template.name);
  const valid = !!name.trim() && !taken;
  const save = () => {
    if (!valid) return;
    saveWatchTemplate({ ...template, name: name.trim() }, template.name);
    onDone();
  };
  return (
    <div
      className="set-row"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onDone();
        }
      }}
    >
      <div className="col-text flex-1">
        <TextField
          value={name}
          onChange={setName}
          label={$t('Name der Vorlage')}
          autoFocus
          invalid={!valid}
          onEnter={save}
        />
        {taken && <span className="small tone-danger">{$t('Eine Vorlage mit diesem Namen gibt es schon.')}</span>}
      </div>
      <Button small onClick={onDone}>
        {$t('Abbrechen')}
      </Button>
      <Button small variant="primary" disabled={!valid} onClick={save}>
        {$t('Sichern')}
      </Button>
    </div>
  );
}
