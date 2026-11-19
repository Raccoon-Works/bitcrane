/**
 * CodeMirror setup of the built-in editor (CodeEditor.tsx): colours, look,
 * words, indentation guess and the extensions every document gets.
 */
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completeAnyWord,
  completionKeymap,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { gotoLine, highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  type ViewUpdate,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { $t } from '../i18n';
import type { EditorPrefs } from '../state/editor';

/** Syntax colours as CSS variables, so the light and the dark theme each set their own. */
const highlight = HighlightStyle.define([
  {
    tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier],
    color: 'var(--syn-keyword)',
  },
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
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--ce-selection) !important',
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--ce-match)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--ce-match)', outline: '1px solid var(--line-strong, var(--line))' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--bg-control)',
    border: 'none',
    color: 'var(--text-muted)',
    padding: '0 6px',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-popover, var(--bg-card))',
    border: '1px solid var(--line)',
    borderRadius: '8px',
    color: 'var(--text)',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--sel-row)', color: 'var(--sel-fg)' },
  '.cm-panels': {
    backgroundColor: 'var(--bg-pane-head, var(--bg-section))',
    color: 'var(--text)',
    borderTop: '1px solid var(--line)',
  },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--line)' },
  '.cm-searchMatch': { backgroundColor: 'var(--ce-search)', outline: '1px solid var(--ce-search-line)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--ce-search-sel)' },
});

/** Indentation of a text: tabs, or the smallest step of leading spaces (2 or 4 …). */
export function guessIndent(text: string, fallback: number): string {
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
  Find: $t('Suchen'),
  Replace: $t('Ersetzen'),
  next: $t('Weiter'),
  previous: $t('Zurück'),
  all: $t('Alle'),
  'match case': $t('Groß/klein'),
  regexp: $t('Regulärer Ausdruck'),
  'by word': $t('Ganzes Wort'),
  replace: $t('Ersetzen'),
  'replace all': $t('Alle ersetzen'),
  close: $t('Schließen'),
  'Go to line': $t('Gehe zu Zeile'),
  go: 'OK',
  'Folded lines': $t('Eingeklappte Zeilen'),
  'Unfolded lines': $t('Ausgeklappte Zeilen'),
  'folded code': $t('eingeklappter Code'),
  unfold: $t('ausklappen'),
  'Fold line': $t('Zeile einklappen'),
  'Unfold line': $t('Zeile ausklappen'),
  'current match': $t('aktueller Treffer'),
  'on line': $t('in Zeile'),
  'replaced match on line $': $t('Treffer in Zeile $ ersetzt'),
  'replaced $ matches': $t('$ Treffer ersetzt'),
  Completions: $t('Vorschläge'),
});

export const fontTheme = (size: number) => EditorView.theme({ '&': { fontSize: `${size}px` } });

export const languageNames = [...languages].sort((a, b) => a.name.localeCompare(b.name)).map((l) => l.name);

/** Settings that can change while documents are open, each in its own compartment. */
export interface Compartments {
  lang: Compartment;
  wrap: Compartment;
  indent: Compartment;
  font: Compartment;
}

export const newCompartments = (): Compartments => ({
  lang: new Compartment(),
  wrap: new Compartment(),
  indent: new Compartment(),
  font: new Compartment(),
});

/** The extensions of one document: editing aids, look, settings and its own keys. */
export function documentExtensions({
  prefs,
  unit,
  comp,
  onSave,
  onSaveAs,
  onClose,
  onUpdate,
}: {
  prefs: EditorPrefs;
  unit: string;
  comp: Compartments;
  onSave: () => void;
  onSaveAs: () => void;
  onClose: () => void;
  onUpdate: (u: ViewUpdate) => void;
}): Extension[] {
  const run = (action: () => void) => () => {
    action();
    return true;
  };
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ override: [completeAnyWord], activateOnTyping: true }),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: false }),
    syntaxHighlighting(highlight),
    EditorState.phrases.of(phrases()),
    look,
    comp.lang.of([]),
    comp.wrap.of(prefs.wrap ? EditorView.lineWrapping : []),
    comp.indent.of([indentUnit.of(unit), EditorState.tabSize.of(prefs.tabSize)]),
    comp.font.of(fontTheme(prefs.fontSize)),
    keymap.of([
      { key: 'Mod-s', preventDefault: true, run: run(onSave) },
      { key: 'Mod-Shift-s', preventDefault: true, run: run(onSaveAs) },
      { key: 'Mod-w', preventDefault: true, run: run(onClose) },
      { key: 'Mod-g', preventDefault: true, run: gotoLine },
      { key: 'Mod-/', preventDefault: true, run: toggleComment },
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of(onUpdate),
  ];
}
