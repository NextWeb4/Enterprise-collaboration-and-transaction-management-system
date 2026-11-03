import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider } from 'antd';
import 'antd/dist/reset.css';
import './styles.css';
import { App } from './App';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ConfigProvider theme={{ token: { colorPrimary: '#1f4d3a', borderRadius: 8, fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif' } }}>
      <App />
    </ConfigProvider>
  </React.StrictMode>,
);

