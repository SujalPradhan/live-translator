import { app } from 'electron';
import { launch } from './application.mjs';

if (!app.requestSingleInstanceLock()) app.quit();
else launch().catch(error => { console.error('Application startup failed:', error.message); app.quit(); });
