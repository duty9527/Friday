import { CSPProvider } from '@base-ui/react/csp-provider';
import '@fontsource-variable/inter';
import '@fontsource-variable/geist-mono';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ToastProvider } from '@/components/ui/toast';
import { TooltipProvider } from '@/components/ui/tooltip';
import { FridayProvider } from '@/lib/friday-store';
import { App } from '@/App';
import '@/styles/globals.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Missing #root mount element');

createRoot(rootEl).render(
  <StrictMode>
    <CSPProvider disableStyleElements>
      <ToastProvider>
        <TooltipProvider>
          <FridayProvider>
            <App />
          </FridayProvider>
        </TooltipProvider>
      </ToastProvider>
    </CSPProvider>
  </StrictMode>,
);
