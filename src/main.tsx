import { createRoot } from 'react-dom/client';
import { isTauri } from '@tauri-apps/api/core';
import { App } from './App';
import { errorText } from './state';
import './styles.css';

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('HUD root element is missing.');
const root = createRoot(rootElement);
const native = isTauri();
document.documentElement.dataset.runtime = native ? 'native' : 'demo';

if (native) {
  root.render(<App native initialSnapshot={{ sessions: [], collectors: [] }}/>);
} else {
  root.render(<main className="boot-state"><span className="demo-badge mono">DEMO</span><p>正在载入浏览器验收数据…</p></main>);
  import('./demo').then(demo => {
    root.render(<App native={false} initialSnapshot={demo.createDemoSnapshot(Date.now())} demo={demo}/>);
  }).catch(error => {
    root.render(<main className="boot-state"><span className="demo-badge mono">DEMO</span><h1>验收数据载入失败</h1><p role="alert">{errorText(error)}</p><button onClick={() => window.location.reload()}>重新载入</button></main>);
  });
}
