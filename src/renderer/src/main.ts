import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.css';
import 'highlight.js/styles/github-dark.min.css';
import 'diff2html/bundles/css/diff2html.min.css';
import '@xterm/xterm/css/xterm.css';
// Bundled with the app (the page's CSP allows no remote fonts).
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource-variable/material-symbols-outlined';
import './styles.css';
import { App } from './app';
import { installErrorReporting } from './error_reporting';

installErrorReporting(window, (error) => void window.api.invoke('log:renderer-error', error).catch(() => {}));

new App().start(document.getElementById('app')!);
