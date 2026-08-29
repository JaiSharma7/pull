import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@wap/ui/styles.css';
import './styles/fonts.css';
import { App } from './App.js';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
