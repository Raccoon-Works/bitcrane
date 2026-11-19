/**
 * What the built-in editor keeps per open document while another one is shown:
 * its CodeMirror state (text, undo history, cursor), the text as last saved
 * and its language. Closed documents are forgotten.
 */
import type { EditorState, Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { useEffect, useRef, type RefObject } from 'react';
import { registerText, type EditorDoc } from '../state/editor';

export interface DocumentCache {
  states: Map<string, EditorState>;
  /** The text as read or last saved: the reference for "unsaved changes". */
  saved: Map<string, Text>;
  /** Name of the language whose colours the document has. */
  langOf: Map<string, string>;
  /** Keeps a new document's state and lets the store read its current text. */
  add: (id: string, state: EditorState) => void;
}

export function useDocumentCache(
  view: RefObject<EditorView | null>,
  docs: EditorDoc[],
  active: string | null,
): DocumentCache {
  const activeRef = useRef(active);
  activeRef.current = active;
  const cache = useRef<DocumentCache | null>(null);
  if (!cache.current) {
    const states = new Map<string, EditorState>();
    cache.current = {
      states,
      saved: new Map(),
      langOf: new Map(),
      add: (id, state) => {
        states.set(id, state);
        // The shown document's text lives in the view, which is ahead of its kept state.
        registerText(id, () =>
          view.current && activeRef.current === id
            ? view.current.state.doc.toString()
            : (states.get(id)?.doc.toString() ?? ''),
        );
      },
    };
  }
  const c = cache.current;

  useEffect(() => {
    for (const id of [...c.states.keys()])
      if (!docs.some((d) => d.id === id)) {
        c.states.delete(id);
        c.saved.delete(id);
        c.langOf.delete(id);
      }
  }, [c, docs]);

  return c;
}
