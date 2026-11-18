/**
 * Entry point of the Bitcrane user interface.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
// Fonts ship with the app instead of coming from Google Fonts: no request leaves the computer
// on start, and the Content Security Policy needs no outside font host.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles/tokens.css';
import './styles/app.css';
import './styles/palette.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
