import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import { App } from './App';

try {
  const th = localStorage.getItem('ccgs-theme');
  if (th) document.documentElement.dataset.theme = th;
} catch { /* storage unavailable */ }

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter><App /></BrowserRouter>
  </StrictMode>,
);
