import { createRoot } from 'react-dom/client';
import '@fontsource-variable/geist';
import '@mayurajs/ui/styles.css';
import '../.generated/shell.css';
import { App } from './app.js';

createRoot(document.getElementById('root')!).render(<App />);
