import React from 'react';
import ReactDOM from 'react-dom/client';
import { isTauri } from '@tauri-apps/api/core';
import App from './App';
import { captureHubToken, isHubMode } from './transport';
import './styles.css';
import 'chunks-ui/theme.css';
import 'highlight.js/styles/github-dark.css';

if (import.meta.env.DEV && !isTauri()) {
  const { install } = await import('./dev/mockBackend');
  install();
}

// Strip the launch URL's `#token=…` before anything renders (or the user bookmarks the page).
if (isHubMode()) captureHubToken();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
