import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { darkTwClass } from '../theme.css';
import { ResearchApp } from './ResearchApp';

document.documentElement.classList.add(darkTwClass);
const root = document.getElementById('root');
if (!root) throw new Error('Research root is missing');
createRoot(root).render(<StrictMode><ResearchApp /></StrictMode>);
