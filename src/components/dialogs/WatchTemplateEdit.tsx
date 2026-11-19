/**
 * Editing an own watch template (Settings › Überwachung › Bearbeiten): its name and the parts of
 * the watch dialog a template carries. Folders, server and rule belong to a single watch and are
 * not shown.
 */
import { useState } from 'react';
import { askDeleteWatchTemplate, closeDialog, saveWatchTemplate, templateNameTaken, useStore } from '../../state/store';
import { WatchIcon } from '../icons';
import { Button, TextField } from '../ui';
import { Dialog } from './Dialog';
import { WatchBehaviour, WatchCommand, WatchExcludes, WatchMoreOptions } from './WatchFields';
import { useWatchOptions } from './useWatchOptions';
import { $t } from '../../i18n';

export function WatchTemplateEdit({ name: previousName }: { name: string }) {
  const platform = useStore((s) => s.platform);
  const templates = useStore((s) => s.settings.watchTemplates);
  // Opened from the list of templates, so the template exists.
  const template = templates.find((t) => t.name === previousName)!;
  const [name, setName] = useState(template.name);
  const [excludes, setExcludes] = useState(template.excludes);
  const { opts, set } = useWatchOptions(template.options);

  const taken = templateNameTaken(templates, name, previousName);
  const valid = !!name.trim() && !taken;
  const submit = () => {
    if (!valid) return;
    saveWatchTemplate({ name: name.trim(), excludes, options: opts }, previousName);
    closeDialog();
  };

  return (
    <Dialog
      label={$t('Vorlage bearbeiten')}
      title={$t('Vorlage „{0}“ bearbeiten', previousName)}
      subtitle={$t('Gilt für neue Überwachungen, die diese Vorlage wählen. Bestehende bleiben, wie sie sind.')}
      icon={
        <span className="icon-tile tone-accent">
          <WatchIcon size={20} waves={2} />
        </span>
      }
      width={760}
      maxHeight={720}
      footer={
        <>
          <Button variant="link" className="tone-danger-text" onClick={() => askDeleteWatchTemplate(previousName)}>
            {$t('Vorlage löschen')}
          </Button>
          <span className="flex-1" />
          <Button onClick={closeDialog}>{$t('Abbrechen')}</Button>
          <Button variant="primary" disabled={!valid} onClick={submit}>
            {$t('Sichern')} <span className="btn-key">{platform === 'mac' ? '⌘↩' : 'Strg+Enter'}</span>
          </Button>
        </>
      }
    >
      <div
        className="form-stack"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
        }}
      >
        <div className="form-grid section-card">
          <label htmlFor="wt-name">{$t('Name')}</label>
          <TextField id="wt-name" value={name} onChange={setName} invalid={!valid} />
          {taken && (
            <>
              <span />
              <span className="small tone-danger">{$t('Eine Vorlage mit diesem Namen gibt es schon.')}</span>
            </>
          )}
        </div>
        <WatchBehaviour opts={opts} set={set} />
        <WatchExcludes excludes={excludes} onChange={setExcludes} />
        <WatchMoreOptions opts={opts} set={set} command={<WatchCommand opts={opts} set={set} />} />
      </div>
    </Dialog>
  );
}
