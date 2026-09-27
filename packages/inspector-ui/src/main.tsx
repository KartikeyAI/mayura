import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setNonce } from 'get-nonce';
import { App } from './App';
import './styles.css';

// Dialog scroll locking injects one <style> element; the server issues a per-response nonce so the CSP stays strict.
const nonce = document.querySelector('meta[name="mayura-style-nonce"]')?.getAttribute('content');
if (nonce && /^[A-Za-z0-9+/]{22}==$/.test(nonce)) setNonce(nonce);

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
