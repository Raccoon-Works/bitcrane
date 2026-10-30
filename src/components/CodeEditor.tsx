/**
 * Built-in code editor (CodeMirror 6), shown in place of the two file halves.
 *
 * What it brings: colours for about 100 languages (loaded only when a file of
 * that kind opens), line numbers, folding, matching brackets, several cursors
 * (⌥-click, ⌘D for the next match), search and replace with regular
 * expressions, go to line, word completion, comment toggling, line moving,
 * automatic indentation detection, and the file's own line endings and byte
 * order mark kept on saving. Each document keeps its own undo history and
 * cursor while switching between them.
 *
 * Deliberately left out (they would make Bitcrane noticeably larger or slower
 * for little gain): a minimap, language servers (IntelliSense), a debugger and
 * extensions. For that, a desktop editor can still be chosen in the settings.
 */
import { autocompletion, closeBrackets, closeBracketsKeymap, completeAnyWord, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands';
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, indentUnit, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { gotoLine, highlightSelectionMatches, openSearchPanel, search, searchKeymap, selectNextOccurrence } from '@codemirror/search';
import { Compartment, EditorState, type Extension, type Text } from '@codemirror/state';
import { crosshairCursor, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { ArrowLeft, FilePlus, FloppyDisk, FolderOpen, MagnifyingGlass, TextAlignLeft, X } from '@phosphor-icons/react';
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { $t } from '../i18n';
import { setMenuKeyHandler, cancelClose, closeDoc, closeNow, docPlace, hideEditor, markDirty, newDocument, openFile, registerText, reloadDoc, saveAs, saveDoc, setActive, setEol, useEditor } from '../state/editor';
import { LIVE, updateSettings, useStore } from '../state/store';
import { FileGlyph } from './icons';
import { Button, IconButton } from './ui';

/** Editor settings with their standard values. */
export interface EditorPrefs { fontSize: number; wrap: boolean; tabSize: number }
export const EDITOR_DEFAULTS: EditorPrefs = { fontSize: 13, wrap: false, tabSize: 4 };

/** Syntax colours as CSS variables, so the light and the dark theme each set their own. */
const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier], color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: 'var(--syn-string)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--syn-function)' },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.variableName)], color: 'var(--syn-type)' },
  { tag: [t.propertyName, t.attributeName, t.labelName], color: 'var(--syn-property)' },
  { tag: [t.tagName, t.angleBracket], color: 'var(--syn-tag)' },
  { tag: [t.definition(t.variableName), t.self, t.special(t.variableName)], color: 'var(--syn-variable)' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: 'var(--syn-punct)' },
  { tag: [t.heading, t.strong], fontWeight: '700', color: 'var(--syn-heading)' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: [t.link, t.url], color: 'var(--syn-string)', textDecoration: 'underline' },
  { tag: [t.meta, t.processingInstruction, t.annotation], color: 'var(--syn-meta)' },
  { tag: t.invalid, color: 'var(--danger, #ff6b6b)' },
]);

/** Look of the editor in Bitcrane's colours (CSS variables, both themes). */
const look = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--bg-card)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--accent-text)', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent-text)', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: 'var(--bg-card)', color: 'var(--text-faint)', border: 'none', paddingRight: '4px' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-2)' },
  '.cm-activeLine': { backgroundColor: 'var(--ce-active-line)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--ce-selection) !important' },
  '.cm-selectionMatch': { backgroundColor: 'var(--ce-match)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--ce-match)', outline: '1px solid var(--line-strong, var(--line))' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--bg-control)', border: 'none', color: 'var(--text-muted)', padding: '0 6px' },
  '.cm-tooltip': { backgroundColor: 'var(--bg-popover, var(--bg-card))', border: '1px solid var(--line)', borderRadius: '8px', color: 'var(--text)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--sel-row)', color: 'var(--sel-fg)' },
  '.cm-panels': { backgroundColor: 'var(--bg-pane-head, var(--bg-section))', color: 'var(--text)', borderTop: '1px solid var(--line)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
  '.cm-searchMatch': { backgroundColor: 'var(--ce-search)', outline: '1px solid var(--ce-search-line)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--ce-search-sel)' },
});

/** Indentation of a text: tabs, or the smallest step of leading spaces (2 or 4 …). */
function guessIndent(text: string, fallback: number): string {
  let tabs = 0;
  const steps: number[] = [];
  for (const line of text.split('\n', 400)) {
    if (line.startsWith('\t')) tabs++;
    else {
      const m = /^( +)\S/.exec(line);
      if (m) steps.push(m[1].length);
    }
  }
  if (tabs > steps.length) return '\t';
  const step = steps.filter((n) => n >= 2).reduce((a, b) => Math.min(a, b), 99);
  return ' '.repeat(step >= 2 && step <= 8 ? step : fallback);
}

/** CodeMirror's own words (search panel, go to line, folding) in the interface language. */
const phrases = () => ({
  'Find': $t('Suchen'), 'Replace': $t('Ersetzen'), 'next': $t('Weiter'), 'previous': $t('Zurück'), 'all': $t('Alle'),
  'match case': $t('Groß/klein'), 'regexp': $t('Regulärer Ausdruck'), 'by word': $t('Ganzes Wort'), 'replace': $t('Ersetzen'),
  'replace all': $t('Alle ersetzen'), 'close': $t('Schließen'), 'Go to line': $t('Gehe zu Zeile'), 'go': 'OK',
  'Folded lines': $t('Eingeklappte Zeilen'), 'Unfolded lines': $t('Ausgeklappte Zeilen'), 'folded code': $t('eingeklappter Code'),
  'unfold': $t('ausklappen'), 'Fold line': $t('Zeile einklappen'), 'Unfold line': $t('Zeile ausklappen'),
  'current match': $t('aktueller Treffer'), 'on line': $t('in Zeile'), 'replaced match on line $': $t('Treffer in Zeile $ ersetzt'),
  'replaced $ matches': $t('$ Treffer ersetzt'), 'Completions': $t('Vorschläge'),
});

const languageNames = [...languages].sort((a, b) => a.name.localeCompare(b.name)).map((l) => l.name);

export function CodeEditor() {
  const ed = useEditor();
  const savedPrefs = useStore((s) => s.settings.editorPrefs);
  const prefs = useMemo(() => ({ ...EDITOR_DEFAULTS, ...(savedPrefs ?? {}) }), [savedPrefs]);
  const mac = useStore((s) => s.platform === 'mac');
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Per document: its CodeMirror state, the text as last saved, and its language name.
  const states = useRef(new Map<string, EditorState>());
  const saved = useRef(new Map<string, Text>());
  const langOf = useRef(new Map<string, string>());
  const comp = useMemo(() => ({ lang: new Compartment(), wrap: new Compartment(), indent: new Compartment(), font: new Compartment() }), []);
  const [cursor, setCursor] = useState({ line: 1, col: 1, sel: 0 });
  const [langName, setLangName] = useState('');
  const [indentText, setIndentText] = useState('');
  const doc = ed.docs.find((d) => d.id === ed.active) ?? null;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const fontTheme = (size: number) => EditorView.theme({ '&': { fontSize: `${size}px` } });

  /** Loads the colours for a language (by name or file name) into the editor. */
  const applyLanguage = async (id: string, desc: LanguageDescription | null) => {
    const support = desc ? await desc.load().catch(() => null) : null;
    const v = view.current;
    langOf.current.set(id, desc?.name ?? '');
    if (v && ed.active === id) {
      v.dispatch({ effects: comp.lang.reconfigure(support ?? []) });
      setLangName(desc?.name ?? '');
    } else {
      const s = states.current.get(id);
      if (s) states.current.set(id, s.update({ effects: comp.lang.reconfigure(support ?? []) }).state);
    }
  };

  const makeState = (id: string, text: string): EditorState => {
    const p = prefsRef.current;
    const unit = guessIndent(text, p.tabSize);
    const extensions: Extension[] = [
      lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), foldGutter(), drawSelection(), dropCursor(),
      EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), closeBrackets(),
      autocompletion({ override: [completeAnyWord], activateOnTyping: true }), rectangularSelection(), crosshairCursor(),
      highlightActiveLine(), highlightSelectionMatches(), search({ top: false }),
      syntaxHighlighting(highlight),
      EditorState.phrases.of(phrases()),
      look,
      comp.lang.of([]),
      comp.wrap.of(p.wrap ? EditorView.lineWrapping : []),
      comp.indent.of([indentUnit.of(unit), EditorState.tabSize.of(p.tabSize)]),
      comp.font.of(fontTheme(p.fontSize)),
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { void saveDoc(id); return true; } },
        { key: 'Mod-Shift-s', preventDefault: true, run: () => { void saveAs(id); return true; } },
        { key: 'Mod-w', preventDefault: true, run: () => { closeDoc(id); return true; } },
        { key: 'Mod-g', preventDefault: true, run: gotoLine },
        { key: 'Mod-/', preventDefault: true, run: toggleComment },
        ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) markDirty(id, !u.state.doc.eq(saved.current.get(id) ?? u.startState.doc));
        if (u.docChanged || u.selectionSet) {
          const r = u.state.selection.main;
          const line = u.state.doc.lineAt(r.head);
          setCursor({ line: line.number, col: r.head - line.from + 1, sel: u.state.selection.ranges.reduce((n, x) => n + (x.to - x.from), 0) });
        }
      }),
    ];
    const state = EditorState.create({ doc: text, extensions });
    saved.current.set(id, state.doc);
    setIndentText(unit === '\t' ? $t('Tabs') : $t('{0} Leerzeichen', unit.length));
    return state;
  };

  // One EditorView; documents swap their states in and out of it.
  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({ parent: host.current });
    view.current = v;
    return () => { v.destroy(); view.current = null; };
  }, []);

  // ⌘ shortcuts that the Mac menu bar would otherwise take (state/editor.ts editorMenuKey).
  const activeRef = useRef(ed.active);
  activeRef.current = ed.active;
  useEffect(() => {
    setMenuKeyHandler((k) => {
      const v = view.current;
      const id = activeRef.current;
      if (!v || !id) return false;
      switch (k) {
        case '⌘W': closeDoc(id); return true;
        case '⌘S': void saveDoc(id); return true;
        case '⇧⌘S': void saveAs(id); return true;
        case '⌘F': openSearchPanel(v); return true;
        case '⌘D': selectNextOccurrence(v); return true;
        case '⌘/': toggleComment(v); return true;
        case '⌘G': gotoLine(v); return true;
        default: return false;
      }
    });
    return () => setMenuKeyHandler(null);
  }, []);

  // Switches to the active document (creating its state the first time).
  useEffect(() => {
    const v = view.current;
    if (!v || !doc || doc.loading || doc.error) return;
    let s = states.current.get(doc.id);
    const isNew = !s;
    if (!s) {
      s = makeState(doc.id, doc.initial);
      states.current.set(doc.id, s);
      registerText(doc.id, () => (ed.active === doc.id && view.current ? view.current.state.doc.toString() : (states.current.get(doc.id)?.doc.toString() ?? '')));
    }
    v.setState(s);
    if (isNew) void applyLanguage(doc.id, doc.path || doc.name ? LanguageDescription.matchFilename(languages, doc.name) : null);
    else setLangName(langOf.current.get(doc.id) ?? '');
    const r = s.selection.main;
    const line = s.doc.lineAt(r.head);
    setCursor({ line: line.number, col: r.head - line.from + 1, sel: 0 });
    v.focus();
    return () => {
      // Keep the state (text, history, cursor) for when the document is shown again.
      if (view.current && states.current.has(doc.id)) states.current.set(doc.id, view.current.state);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.id, doc?.loading, doc?.error]);

  // Text getters always read the live view for the shown document.
  useEffect(() => {
    for (const d of ed.docs) {
      if (states.current.has(d.id)) registerText(d.id, () => (view.current && ed.active === d.id ? view.current.state.doc.toString() : (states.current.get(d.id)?.doc.toString() ?? '')));
    }
    // Forget the states of closed documents.
    for (const id of [...states.current.keys()]) if (!ed.docs.some((d) => d.id === id)) { states.current.delete(id); saved.current.delete(id); langOf.current.delete(id); }
  }, [ed.docs, ed.active]);

  // After saving, the saved text is the new reference for "unsaved changes".
  useEffect(() => {
    const v = view.current;
    if (v && doc && !doc.dirty && states.current.has(doc.id)) saved.current.set(doc.id, v.state.doc);
  }, [doc, doc?.dirty]);

  // Settings changed: apply them to the view and the kept states.
  useEffect(() => {
    const effects = [
      comp.wrap.reconfigure(prefs.wrap ? EditorView.lineWrapping : []),
      comp.font.reconfigure(fontTheme(prefs.fontSize)),
    ];
    view.current?.dispatch({ effects });
    for (const [id, s] of states.current) if (id !== ed.active) states.current.set(id, s.update({ effects }).state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.wrap, prefs.fontSize]);

  const chooseLanguage = (name: string) => {
    if (!doc) return;
    void applyLanguage(doc.id, name ? languages.find((l) => l.name === name) ?? null : null);
  };

  const openLocal = async () => {
    if (!LIVE) { void openFile('', '~/Projekte/taskbot/bot.py'); return; }
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ multiple: true, directory: false, title: $t('Im Editor öffnen') }).catch(() => null);
    const list = Array.isArray(picked) ? picked : picked ? [picked] : [];
    for (const p of list) void openFile('', await invoke<string>('path_to_ui', { path: p }));
  };

  const key = (m: string, w: string) => (mac ? m : w);

  return (
    <section className="code-editor" aria-label={$t('Editor')}>
      <div className="ce-head">
        <IconButton label={$t('Zurück zu den Dateien')} onClick={hideEditor}><ArrowLeft size={17} /></IconButton>
        <div className="ce-tabs" role="tablist">
          {ed.docs.map((d) => (
            <div key={d.id} role="tab" aria-selected={d.id === ed.active} className={`ce-tab${d.id === ed.active ? ' is-on' : ''}`} title={docPlace(d)}
              onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); closeDoc(d.id); } else if (e.button === 0) setActive(d.id); }}>
              <FileGlyph size={16} name={d.name} />
              <span className="ellipsis">{d.name}</span>
              {d.serverId ? <span className="ce-remote" title={docPlace(d)} /> : null}
              <button type="button" className={`ce-close${d.dirty ? ' is-dirty' : ''}`} aria-label={$t('„{0}“ schließen', d.name)} onMouseDown={(e) => e.stopPropagation()} onClick={() => closeDoc(d.id)}>
                <span className="ce-dot" aria-hidden="true" /><X size={12} weight="bold" aria-hidden="true" />
              </button>
            </div>
          ))}
          <IconButton label={$t('Neues Dokument')} onClick={newDocument}><FilePlus size={17} /></IconButton>
        </div>
        <span className="flex-1" />
        <IconButton label={$t('Datei öffnen …')} onClick={() => void openLocal()}><FolderOpen size={18} /></IconButton>
        <IconButton label={$t('Suchen und ersetzen')} shortcut={key('⌘F', 'Strg+F')} disabled={!doc} onClick={() => { const v = view.current; if (v) { openSearchPanel(v); } }}><MagnifyingGlass size={18} /></IconButton>
        <IconButton label={$t('Zeilenumbruch')} active={prefs.wrap} onClick={() => updateSettings({ editorPrefs: { ...prefs, wrap: !prefs.wrap } })}><TextAlignLeft size={18} /></IconButton>
        <Button small variant="primary" disabled={!doc || (!doc.dirty && doc.serverId !== null)} onClick={() => doc && void saveDoc(doc.id)}>
          <FloppyDisk size={15} aria-hidden="true" />{doc?.serverId ? $t('Sichern und hochladen') : $t('Sichern')}
        </Button>
      </div>

      {doc && ed.confirmClose === doc.id && (
        <div className="ce-banner" role="alertdialog">
          <span>{$t('„{0}“ hat Änderungen, die noch nicht gesichert sind.', doc.name)}</span>
          <span className="flex-1" />
          <Button small onClick={cancelClose}>{$t('Abbrechen')}</Button>
          <Button small onClick={() => closeNow(doc.id)}>{$t('Nicht sichern')}</Button>
          <Button small variant="primary" onClick={() => void saveDoc(doc.id).then((ok) => { if (ok) closeNow(doc.id); })}>{$t('Sichern')}</Button>
        </div>
      )}
      {doc?.conflict && (
        <div className="ce-banner is-warn" role="alert">
          <span>{$t('„{0}“ wurde inzwischen woanders geändert.', doc.name)}</span>
          <span className="flex-1" />
          <Button small onClick={() => void reloadDoc(doc.id)}>{$t('Neu laden (eigene Änderungen verwerfen)')}</Button>
          <Button small variant="primary" onClick={() => void saveDoc(doc.id, true)}>{$t('Trotzdem überschreiben')}</Button>
        </div>
      )}

      <div className="ce-body">
        <div className="ce-host" ref={host} style={{ visibility: doc && !doc.loading && !doc.error ? 'visible' : 'hidden' }} />
        {doc?.loading && <div className="ce-note">{$t('Wird geladen …')}</div>}
        {doc?.error && <div className="ce-note is-error">{doc.error}</div>}
        {!doc && <div className="ce-note">{$t('Kein Dokument offen.')}</div>}
      </div>

      <div className="ce-status">
        {doc && !doc.loading && !doc.error ? (
          <>
            <span>{$t('Zeile {0}, Spalte {1}', cursor.line, cursor.col)}{cursor.sel ? ` · ${$t('{0} ausgewählt', cursor.sel)}` : ''}</span>
            <span className="flex-1 ellipsis ce-place" title={docPlace(doc)}>{docPlace(doc)}</span>
            <select className="ce-select" value={langName} onChange={(e) => chooseLanguage(e.target.value)} aria-label={$t('Sprache')}>
              <option value="">{$t('Nur Text')}</option>
              {languageNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <span>{indentText}</span>
            <button type="button" className="ce-status-btn" title={$t('Zeilenende umschalten')} onClick={() => setEol(doc.id, doc.eol === '\n' ? '\r\n' : '\n')}>{doc.eol === '\n' ? 'LF' : 'CRLF'}</button>
            <span>{doc.bom ? 'UTF-8 BOM' : 'UTF-8'}</span>
          </>
        ) : <span className="flex-1" />}
      </div>
    </section>
  );
}
