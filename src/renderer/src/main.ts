import 'bootstrap/dist/css/bootstrap.min.css';
import 'bootstrap-icons/font/bootstrap-icons.css';
import 'highlight.js/styles/github-dark.min.css';
import 'diff2html/bundles/css/diff2html.min.css';
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { App } from './app';

new App().start(document.getElementById('app')!);
