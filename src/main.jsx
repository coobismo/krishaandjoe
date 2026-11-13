import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { getMemoriesRedirect } from './features/photos/memoriesRoute.mjs';
import './styles.css';

const memoriesRedirect = getMemoriesRedirect(window.location);
if (memoriesRedirect) window.location.replace(memoriesRedirect);
else createRoot(document.getElementById('root')).render(<App />);
