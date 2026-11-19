/**
 * Built-in code editor (CodeMirror 6), shown in place of the two file halves.
 *
 * What it brings: colours for about 100 languages (loaded only when a file of
 * that kind opens), line numbers, folding, matching brackets, several cursors
 * (⌥-click, ⌘D for the next match), search and replace with regular
 * expressions, go to line, word completion, comment toggling, line moving,
 * automatic indentation detection, and the file's own line endings (also
 * mixed ones), encoding (UTF-8 or Latin-1) and byte order mark kept on saving. Each document keeps its own undo history and
 * cursor while switching between them.
 *
 * Deliberately left out (they would make Bitcrane noticeably larger or slower
 * for little gain): a minimap, language servers (IntelliSense), a debugger and
 * extensions. For that, a desktop editor can still be chosen in the settings.
 */
import { toggleComment } from '@codemirror/commands';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { gotoLine, openSearchPanel, selectNextOccurrence } from '@codemirror/search';
import { EditorState, Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import { ArrowLeft, FilePlus, FloppyDisk, FolderOpen, MagnifyingGlass, TextAlignLeft, X } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDocumentCache } from './useDocumentCache';
import { documentExtensions, fontTheme, guessIndent, languageNames, newCompartments } from './codeEditorSetup';
import { $t } from '../i18n';
import {
  setMenuKeyHandler,
  cancelClose,
  closeDoc,
  closeNow,
  docPlace,
  EDITOR_DEFAULTS,
  hideEditor,
  keepTexts,
  markDirty,
  newDocument,
  openLocalFiles,
  reloadDoc,
  saveAs,
  saveDoc,
  setActive,
  setEol,
  useEditor,
} from '../state/editor';
import { updateSettings, useStore } from '../state/store';
import { FileGlyph } from './icons';
import { Button, IconButton } from './ui';

export function CodeEditor() {
  const ed = useEditor();
  const savedPrefs = useStore((s) => s.settings.editorPrefs);
  const prefs = useMemo(() => ({ ...EDITOR_DEFAULTS, ...(savedPrefs ?? {}) }), [savedPrefs]);
  const mac = useStore((s) => s.platform === 'mac');
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const cache = useDocumentCache(view, ed.docs, ed.active);
  const comp = useMemo(newCompartments, []);
  const [cursor, setCursor] = useState({ line: 1, col: 1, sel: 0 });
  const [langName, setLangName] = useState('');
  const [indentText, setIndentText] = useState('');
  const doc = ed.docs.find((d) => d.id === ed.active) ?? null;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  /** Loads the colours for a language (by name or file name) into the editor. */
  const applyLanguage = async (id: string, desc: LanguageDescription | null) => {
    const support = desc ? await desc.load().catch(() => null) : null;
    const v = view.current;
    cache.langOf.set(id, desc?.name ?? '');
    if (v && ed.active === id) {
      v.dispatch({ effects: comp.lang.reconfigure(support ?? []) });
      setLangName(desc?.name ?? '');
    } else {
      const s = cache.states.get(id);
      if (s) cache.states.set(id, s.update({ effects: comp.lang.reconfigure(support ?? []) }).state);
    }
  };

  const makeState = (id: string, text: string): EditorState => {
    const p = prefsRef.current;
    const unit = guessIndent(text, p.tabSize);
    const extensions = documentExtensions({
      prefs: p,
      unit,
      comp,
      onSave: () => void saveDoc(id),
      onSaveAs: () => void saveAs(id),
      onClose: () => closeDoc(id),
      onUpdate: (u) => {
        if (u.docChanged) markDirty(id, !u.state.doc.eq(cache.saved.get(id) ?? u.startState.doc));
        if (u.docChanged || u.selectionSet) {
          const r = u.state.selection.main;
          const line = u.state.doc.lineAt(r.head);
          setCursor({
            line: line.number,
            col: r.head - line.from + 1,
            sel: u.state.selection.ranges.reduce((n, x) => n + (x.to - x.from), 0),
          });
        }
      },
    });
    // A file with mixed line endings keeps its "\r" characters in the lines (shown as special
    // characters), so saving writes every line back with its own ending.
    const mixed = ed.docs.find((d) => d.id === id)?.eol === 'mixed';
    if (mixed) extensions.push(EditorState.lineSeparator.of('\n'));
    const state = EditorState.create({ doc: text, extensions });
    // The reference for "unsaved changes" is the text as read or last saved, not edits kept from before.
    const ref = ed.docs.find((d) => d.id === id)?.initial;
    cache.saved.set(id, ref !== undefined && ref !== text ? Text.of(ref.split(mixed ? '\n' : /\r?\n/)) : state.doc);
    setIndentText(unit === '\t' ? $t('Tabs') : $t('{0} Leerzeichen', unit.length));
    return state;
  };

  // One EditorView; documents swap their states in and out of it.
  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({ parent: host.current });
    view.current = v;
    const kept = cache.states;
    return () => {
      // Closing the editor keeps what was typed: the texts go into the documents and come back
      // when it opens again. The shown document's text is taken from the view, which is ahead
      // of its kept state.
      const a = activeRef.current;
      if (a && kept.has(a)) kept.set(a, v.state);
      const texts = new Map<string, string>();
      for (const [id, st] of kept) texts.set(id, st.doc.toString());
      keepTexts(texts);
      v.destroy();
      view.current = null;
    };
  }, [cache]);

  // ⌘ shortcuts that the Mac menu bar would otherwise take (state/editor.ts editorMenuKey).
  const activeRef = useRef(ed.active);
  activeRef.current = ed.active;
  useEffect(() => {
    setMenuKeyHandler((k) => {
      const v = view.current;
      const id = activeRef.current;
      if (!v || !id) return false;
      switch (k) {
        case '⌘W':
          closeDoc(id);
          return true;
        case '⌘S':
          void saveDoc(id);
          return true;
        case '⇧⌘S':
          void saveAs(id);
          return true;
        case '⌘F':
          openSearchPanel(v);
          return true;
        case '⌘D':
          selectNextOccurrence(v);
          return true;
        case '⌘/':
          toggleComment(v);
          return true;
        case '⌘G':
          gotoLine(v);
          return true;
        default:
          return false;
      }
    });
    return () => setMenuKeyHandler(null);
  }, []);

  // Switches to the active document (creating its state the first time).
  useEffect(() => {
    const v = view.current;
    if (!v || !doc || doc.loading || doc.error) return;
    let s = cache.states.get(doc.id);
    const isNew = !s;
    if (!s) {
      s = makeState(doc.id, doc.text ?? doc.initial);
      cache.add(doc.id, s);
    }
    v.setState(s);
    if (isNew)
      void applyLanguage(doc.id, doc.path || doc.name ? LanguageDescription.matchFilename(languages, doc.name) : null);
    else setLangName(cache.langOf.get(doc.id) ?? '');
    const r = s.selection.main;
    const line = s.doc.lineAt(r.head);
    setCursor({ line: line.number, col: r.head - line.from + 1, sel: 0 });
    v.focus();
    const kept = cache.states;
    return () => {
      // Keep the state (text, history, cursor) for when the document is shown again.
      if (view.current && kept.has(doc.id)) kept.set(doc.id, view.current.state);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rebuilt only when another document is shown or has loaded; on every edit it would reset the view
  }, [doc?.id, doc?.loading, doc?.error]);

  // After saving, the saved text is the new reference for "unsaved changes".
  useEffect(() => {
    const v = view.current;
    if (v && doc && !doc.dirty && cache.states.has(doc.id)) cache.saved.set(doc.id, v.state.doc);
  }, [cache, doc]);

  // Settings changed: apply them to the view and the kept states.
  useEffect(() => {
    const effects = [
      comp.wrap.reconfigure(prefs.wrap ? EditorView.lineWrapping : []),
      comp.font.reconfigure(fontTheme(prefs.fontSize)),
    ];
    view.current?.dispatch({ effects });
    // The shown document got them through the view; the others are updated in their kept states.
    for (const [id, s] of cache.states) if (id !== activeRef.current) cache.states.set(id, s.update({ effects }).state);
  }, [cache, comp, prefs.wrap, prefs.fontSize]);

  const chooseLanguage = (name: string) => {
    if (!doc) return;
    void applyLanguage(doc.id, name ? (languages.find((l) => l.name === name) ?? null) : null);
  };

  const key = (m: string, w: string) => (mac ? m : w);

  return (
    <section className="code-editor" aria-label={$t('Editor')}>
      <div className="ce-head">
        <IconButton label={$t('Zurück zu den Dateien')} onClick={hideEditor}>
          <ArrowLeft size={17} />
        </IconButton>
        <div className="ce-tabs" role="tablist">
          {ed.docs.map((d) => (
            <div
              key={d.id}
              role="tab"
              aria-selected={d.id === ed.active}
              className={`ce-tab${d.id === ed.active ? ' is-on' : ''}`}
              title={docPlace(d)}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeDoc(d.id);
                } else if (e.button === 0) setActive(d.id);
              }}
            >
              <FileGlyph size={16} name={d.name} />
              <span className="ellipsis">{d.name}</span>
              {d.serverId ? <span className="ce-remote" title={docPlace(d)} /> : null}
              <button
                type="button"
                className={`ce-close${d.dirty ? ' is-dirty' : ''}`}
                aria-label={$t('„{0}“ schließen', d.name)}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => closeDoc(d.id)}
              >
                <span className="ce-dot" aria-hidden="true" />
                <X size={12} weight="bold" aria-hidden="true" />
              </button>
            </div>
          ))}
          <IconButton label={$t('Neues Dokument')} onClick={newDocument}>
            <FilePlus size={17} />
          </IconButton>
        </div>
        <span className="flex-1" />
        <IconButton label={$t('Datei öffnen …')} onClick={() => void openLocalFiles()}>
          <FolderOpen size={18} />
        </IconButton>
        <IconButton
          label={$t('Suchen und ersetzen')}
          shortcut={key('⌘F', 'Strg+F')}
          disabled={!doc}
          onClick={() => {
            const v = view.current;
            if (v) {
              openSearchPanel(v);
            }
          }}
        >
          <MagnifyingGlass size={18} />
        </IconButton>
        <IconButton
          label={$t('Zeilenumbruch')}
          active={prefs.wrap}
          onClick={() => updateSettings({ editorPrefs: { ...prefs, wrap: !prefs.wrap } })}
        >
          <TextAlignLeft size={18} />
        </IconButton>
        <Button
          small
          variant="primary"
          disabled={!doc || (!doc.dirty && doc.serverId !== null)}
          onClick={() => doc && void saveDoc(doc.id)}
        >
          <FloppyDisk size={15} aria-hidden="true" />
          {doc?.serverId ? $t('Sichern und hochladen') : $t('Sichern')}
        </Button>
      </div>

      {doc && ed.confirmClose === doc.id && (
        <div className="ce-banner" role="alertdialog">
          <span>{$t('„{0}“ hat Änderungen, die noch nicht gesichert sind.', doc.name)}</span>
          <span className="flex-1" />
          <Button small onClick={cancelClose}>
            {$t('Abbrechen')}
          </Button>
          <Button small onClick={() => closeNow(doc.id)}>
            {$t('Nicht sichern')}
          </Button>
          <Button
            small
            variant="primary"
            onClick={() =>
              void saveDoc(doc.id).then((ok) => {
                if (ok) closeNow(doc.id);
              })
            }
          >
            {$t('Sichern')}
          </Button>
        </div>
      )}
      {doc?.conflict && (
        <div className="ce-banner is-warn" role="alert">
          <span>{$t('„{0}“ wurde inzwischen woanders geändert.', doc.name)}</span>
          <span className="flex-1" />
          <Button small onClick={() => void reloadDoc(doc.id)}>
            {$t('Neu laden (eigene Änderungen verwerfen)')}
          </Button>
          <Button small variant="primary" onClick={() => void saveDoc(doc.id, true)}>
            {$t('Trotzdem überschreiben')}
          </Button>
        </div>
      )}

      <div className="ce-body">
        <div
          className="ce-host"
          ref={host}
          style={{ visibility: doc && !doc.loading && !doc.error ? 'visible' : 'hidden' }}
        />
        {doc?.loading && <div className="ce-note">{$t('Wird geladen …')}</div>}
        {doc?.error && <div className="ce-note is-error">{doc.error}</div>}
        {!doc && <div className="ce-note">{$t('Kein Dokument offen.')}</div>}
      </div>

      <div className="ce-status">
        {doc && !doc.loading && !doc.error ? (
          <>
            <span>
              {$t('Zeile {0}, Spalte {1}', cursor.line, cursor.col)}
              {cursor.sel ? ` · ${$t('{0} ausgewählt', cursor.sel)}` : ''}
            </span>
            <span className="flex-1 ellipsis ce-place" title={docPlace(doc)}>
              {docPlace(doc)}
            </span>
            <select
              className="ce-select"
              value={langName}
              onChange={(e) => chooseLanguage(e.target.value)}
              aria-label={$t('Sprache')}
            >
              <option value="">{$t('Nur Text')}</option>
              {languageNames.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <span>{indentText}</span>
            <button
              type="button"
              className="ce-status-btn"
              title={$t('Zeilenende umschalten')}
              onClick={() => setEol(doc.id, doc.eol === '\n' ? '\r\n' : '\n')}
            >
              {doc.eol === 'mixed' ? $t('LF/CRLF gemischt') : doc.eol === '\n' ? 'LF' : 'CRLF'}
            </button>
            <span>{doc.encoding === 'latin1' ? 'Latin-1' : doc.bom ? 'UTF-8 BOM' : 'UTF-8'}</span>
          </>
        ) : (
          <span className="flex-1" />
        )}
      </div>
    </section>
  );
}
