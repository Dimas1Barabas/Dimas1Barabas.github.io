import { CssBaseline } from '@mui/material';
import React from 'react';
import { createRoot } from 'react-dom/client';

import App from './components/App.jsx';

createRoot(document.getElementById('root')).render(
  <>
    <CssBaseline />
    <App />
  </>,
);
