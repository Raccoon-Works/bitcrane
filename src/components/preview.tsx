/**
 * Draws a loaded file preview (see usePreview.ts): the start of a text file or
 * an image. Used by the info column and by the preview window (space bar).
 */
import type { Preview } from '../backend/api';
import { $t } from '../i18n';

/** Renders a loaded preview. `maxLines` shortens text (info column). */
export function PreviewView({ preview, maxLines, className = '' }: { preview: Preview; maxLines?: number; className?: string }) {
  if (preview.kind === 'image') {
    return <img className={`preview-image ${className}`} alt="" src={`data:${preview.mime};base64,${preview.data}`} />;
  }
  if (preview.kind === 'media') {
    if (preview.mime === 'application/pdf') return <iframe className={`preview-pdf ${className}`} title={$t('PDF-Vorschau')} src={preview.data} />;
    if (preview.mime.startsWith('audio/')) return <audio className={`preview-audio ${className}`} controls autoPlay src={preview.data} />;
    return <video className={`preview-video ${className}`} controls autoPlay src={preview.data} />;
  }
  if (preview.kind === 'text') {
    const text = maxLines ? preview.data.split('\n').slice(0, maxLines).join('\n') : preview.data;
    return (
      <pre className={`preview-text mono ${className}`}>
        {text || ' '}
        {preview.truncated && !maxLines && <span className="preview-cut">{$t('… Die Datei ist länger; gezeigt wird der Anfang.')}</span>}
      </pre>
    );
  }
  return <p className={`muted small ${className}`}>{preview.truncated ? $t('Zu groß für eine Vorschau.') : $t('Keine Vorschau für diese Art Datei.')}</p>;
}
