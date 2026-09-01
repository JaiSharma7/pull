import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@wap/ui/styles.css';
import './styles/fonts.css';
import { App } from './App.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

/*
 * The boundary wraps `App` rather than living inside it, on purpose. `App` holds the
 * router, the session and the shell, and a throw from any of those is exactly the case
 * with no UI left to catch it — a boundary nested below them would go down with the
 * tree it was meant to survive.
 */
createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
