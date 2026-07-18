import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadToken } from './native';
import './styles.css';

function render() {
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

// Sur natif, on charge d'abord le token de session persisté ; en web, no-op immédiat.
loadToken().finally(render);
