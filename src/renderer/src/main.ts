import './styles.css';

async function start(): Promise<void> {
  const root = document.getElementById('app')!;
  const info = await window.api.invoke('app:info');
  root.textContent = `CodeCompanion ${info.version}`;

  window.api.on('menu:command', (command) => {
    root.dataset.lastCommand = command;
  });
}

start();
