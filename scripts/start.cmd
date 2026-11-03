@echo off
rem 生产启动入口：普通 Windows 进程（不注册服务）；默认仅监听 127.0.0.1。
rem 数据目录必须在本地 NTFS 盘（决策 D-028），按部署环境调整 DATA_DIR。
cd /d %~dp0..
set NODE_ENV=production
set DATA_DIR=D:\collab-office-data
set WEB_ORIGIN=http://127.0.0.1:3000
set LOG_LEVEL=info
node app\backend\dist\server.js
