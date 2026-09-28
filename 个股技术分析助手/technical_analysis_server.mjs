import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync=promisify(execFile);
const here=path.dirname(fileURLToPath(import.meta.url));
const htmlPath=path.join(here,'个股技术分析助手.html');
const userHome=process.env.USERPROFILE||process.env.HOME||'';
const windDir=process.env.WIND_SKILL_DIR||path.join(userHome,'.agents','skills','wind-mcp-skill');
const windCli=path.join(windDir,'scripts','cli.mjs');
const host=process.env.TA_HOST||'127.0.0.1';
const port=Number(process.env.TA_PORT||8799);
const lanMode=process.env.TA_LAN==='1';
const accessCode=String(process.env.TA_ACCESS_CODE||'').trim();
const cache=new Map();
const requestWindows=new Map();

function json(res,status,body){const text=JSON.stringify(body);res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(text),'cache-control':'no-store'});res.end(text)}
function clientIp(req){return String(req.socket.remoteAddress||'').replace(/^::ffff:/,'')}
function isPrivateIp(ip){if(ip==='::1'||ip==='127.0.0.1')return true;if(/^10\./.test(ip)||/^192\.168\./.test(ip)||/^169\.254\./.test(ip)||/^fe80:/i.test(ip))return true;const m=ip.match(/^172\.(\d+)\./);return Boolean(m&&Number(m[1])>=16&&Number(m[1])<=31)}
function rateAllowed(ip){const now=Date.now(),entry=requestWindows.get(ip);if(!entry||now-entry.start>60000){requestWindows.set(ip,{start:now,count:1});return true}entry.count+=1;return entry.count<=30}
function round(n,d=2){return Number(Number(n).toFixed(d))}
function clamp(n,a,b){return Math.max(a,Math.min(b,n))}
function dateText(d){return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`}
function normalizeInput(raw){const q=String(raw||'').trim();if(!q)throw new Error('请输入股票名称或代码');if(!/^[\u4e00-\u9fa5A-Za-z0-9.\-*]{2,30}$/.test(q))throw new Error('股票名称或代码格式不正确');if(/^\d{6}$/.test(q)){if(/^(60|68|69)/.test(q))return `${q}.SH`;if(/^(00|30)/.test(q))return `${q}.SZ`;if(/^(4|8|92)/.test(q))return `${q}.BJ`}return q.toUpperCase()}

async function windCall(server,tool,params,attempt=0){
  try{
    const {stdout}=await execFileAsync(process.execPath,[windCli,'call',server,tool,JSON.stringify(params)],{cwd:windDir,encoding:'utf8',maxBuffer:30*1024*1024,timeout:45000,windowsHide:true});
    const outer=JSON.parse(stdout);if(outer.isError)throw new Error(outer.content?.[0]?.text||'Wind接口返回错误');
    const inner=JSON.parse(outer.content?.[0]?.text||'{}');if(inner.error)throw new Error(typeof inner.error==='string'?inner.error:JSON.stringify(inner.error));
    return inner.data;
  }catch(error){
    const raw=error.stdout||error.message||String(error);let msg=raw;
    try{const e=JSON.parse(raw);msg=e.error?.agent_action||e.error?.message||raw}catch{}
    if(attempt<1&&/(NETWORK_ERROR|fetch failed|HTTP 50[0234]|ECONN|timeout|超时|网络)/i.test(msg)){await new Promise(resolve=>setTimeout(resolve,700));return windCall(server,tool,params,attempt+1)}
    throw new Error(`Wind ${tool} 调用失败：${msg}`);
  }
}

function table(data){const names=(data?.columns||[]).map(x=>x.name);return (data?.rows||[]).map(row=>Object.fromEntries(names.map((name,i)=>[name,row[i]])))}
function num(v){const n=Number(v);return Number.isFinite(n)?n:0}
function sma(values,n){if(values.length<n)return 0;return values.slice(-n).reduce((a,b)=>a+b,0)/n}
function ema(values,n){if(!values.length)return[];const k=2/(n+1),out=[values[0]];for(let i=1;i<values.length;i++)out.push(values[i]*k+out[i-1]*(1-k));return out}
function std(values){if(!values.length)return 0;const m=values.reduce((a,b)=>a+b,0)/values.length;return Math.sqrt(values.reduce((a,b)=>a+(b-m)**2,0)/values.length)}
function maxOf(arr,key){return Math.max(...arr.map(x=>x[key]))}
function minOf(arr,key){return Math.min(...arr.map(x=>x[key]))}
function nearestAbove(values,price,fallback){const v=values.filter(x=>x>price*1.003).sort((a,b)=>a-b)[0];return v||fallback}
function pctText(n){return `${n>0?'+':''}${round(n)}%`}

function parseQuote(rows){return rows.map(r=>({time:r.TIME,open:num(r.OPEN),close:num(r.MATCH),high:num(r.HIGH),low:num(r.LOW),amount:num(r.TURNOVER),volume:num(r.VOLUME),turnover:num(r.CHANGEHANDRATE),avg:num(r.AVPRICE)}))}
function parseDaily(rows){return rows.map(r=>({time:r.TIME,open:num(r.OPEN),close:num(r.MATCH),high:num(r.HIGH),low:num(r.LOW),amount:num(r.TURNOVER),volume:num(r.VOLUME),turnover:num(r.CHANGEHANDRATE),avg:num(r.AVPRICE)}))}
function marketPct(daily){if(daily.length<2)return 0;const p=daily.at(-2).close,c=daily.at(-1).close;return p?100*(c-p)/p:0}
function dynamicVwap(points){let a=0,v=0;return points.map(p=>{a+=p.amount;v+=p.volume;return v?a/v:p.avg||p.close})}

function buildAnalysis(snapshotRows,stockQuote,stockDaily,markets,styleMarket){
  const snap=snapshotRows[0]||{},daily=parseDaily(stockDaily).slice(-120),intraday=parseQuote(stockQuote),last=daily.at(-1),prev=daily.at(-2),closes=daily.map(x=>x.close),volumes=daily.map(x=>x.volume);
  if(!last||!intraday.length)throw new Error('Wind未返回足够的个股行情数据');
  const price=num(snap['最新成交价'])||last.close,prevClose=num(snap['前收盘价'])||prev?.close||price,stockPct=num(snap['涨跌幅'])||100*(price-prevClose)/prevClose;
  const ma5=sma(closes,5),ma10=sma(closes,10),ma20=sma(closes,20),ma60=sma(closes,60),ma120=sma(closes,120),vol5=sma(volumes,5),vol20=sma(volumes,20),volumeRatio=vol5?last.volume/vol5:1;
  const e12=ema(closes,12),e26=ema(closes,26),dif=closes.map((_,i)=>e12[i]-e26[i]),dea=ema(dif,9),macd=dif.at(-1)-dea.at(-1);
  const last20=closes.slice(-20),bollMid=sma(closes,20),bollStd=std(last20),bollUpper=bollMid+2*bollStd,bollLower=bollMid-2*bollStd;
  const prior20=daily.slice(-21,-1),prior60=daily.slice(-61,-1),prior20High=maxOf(prior20,'high'),prior60High=maxOf(prior60,'high'),low10=minOf(daily.slice(-10),'low'),low20=minOf(daily.slice(-20),'low');
  const recentBreak=daily.slice(-5,-1).some((d,i)=>d.high>maxOf(daily.slice(Math.max(0,daily.length-25+i),daily.length-5+i),'high')*1.005);
  const vwap=dynamicVwap(intraday),dayOpen=intraday[0].open,dayHigh=maxOf(intraday,'high'),dayLow=minOf(intraday,'low'),dayAmount=intraday.reduce((s,x)=>s+x.amount,0),dayVolume=intraday.reduce((s,x)=>s+x.volume,0),dayVwap=dayVolume?dayAmount/dayVolume:num(snap['最新均价'])||last.avg;
  const belowVwap=intraday.filter((p,i)=>p.close<vwap[i]).length/intraday.length,closeLocation=(price-dayLow)/Math.max(.001,dayHigh-dayLow),amplitude=100*(dayHigh-dayLow)/prevClose;
  const sh=markets.sh,sz=markets.sz,style=styleMarket||null,primary=style||(/\.SH$/.test(snap['Wind代码']||'')?sh:sz),relative=stockPct-primary.pct;
  let stage='正常回踩 · 观察',phaseType='pullback';
  if(price>prior20High&&volumeRatio>1.15){stage='确认突破 · 等待跟随';phaseType='breakout'}
  else if(price>=prior20High*.98&&price>=ma20){stage='准备突破 · 临界区';phaseType='ready'}
  else if(recentBreak&&price<prior20High&&price>=ma20*.97){stage='假突破 · 待修复';phaseType='false-break'}
  else if(price<ma20&&price<ma60){stage='弱势结构 · 尚未反转';phaseType='weak'}
  else if(price>=ma20&&volumeRatio<1){stage='缩量回踩 · 趋势未破';phaseType='pullback'}
  const trendScore=clamp((price>ma20?9:3)+(price>ma60?8:2)+(ma20>ma60?5:2)+(ma5>ma10?3:1),0,25);
  const breakoutScore=clamp(phaseType==='breakout'?19:phaseType==='ready'?16:phaseType==='pullback'?13:phaseType==='false-break'?9:6,0,20);
  const volumeScore=clamp((volumeRatio>=1.15&&stockPct>0?13:volumeRatio<.9&&stockPct<0?11:8)+(closeLocation>.55?2:0),0,15);
  const relativeScore=clamp(8+relative*1.8+(stockPct>sh.pct&&stockPct>sz.pct?3:0),0,15);
  const momentumScore=clamp(5+(macd>0?3:-1)+(price>bollMid?2:0)+(belowVwap<.45?1:-1),0,10);
  const marketAvg=(sh.pct+sz.pct)/2,marketScore=clamp(6+marketAvg*1.5+(primary.pct>0?2:0),0,10);
  const repair=nearestAbove([ma5,ma10,ma20,dayVwap],price,Math.max(ma5,ma10,ma20)),confirm=nearestAbove([dayHigh,prior20High,prior60High,bollUpper],repair,prior20High),target=nearestAbove([prior20High,prior60High,bollUpper,maxOf(daily,'high')],confirm,prior60High);
  const invalidation=price>ma20?Math.min(ma20,low10):Math.min(low10,bollLower),risk=Math.max(.01,price-invalidation),reward=Math.max(.01,target-price),rr=reward/risk,rrScore=clamp(rr>=2?5:rr>=1.3?4:rr>=.8?3:1,0,5);
  const score=Math.round(trendScore+breakoutScore+volumeScore+relativeScore+momentumScore+marketScore+rrScore);
  const intradayWeak=belowVwap>.62&&closeLocation<.4;
  let nature='正常回踩 / 获利回吐',headline='结构仍需市场确认';
  if(phaseType==='breakout'){nature='有效突破';headline='量价突破成立，继续观察跟随买盘'}
  else if(phaseType==='false-break'){nature=intradayWeak?'假突破风险上升':'突破回踩待确认';headline='突破后回落，进入关键修复窗口'}
  else if(phaseType==='weak'){nature='弱势减仓 / 筑底未成';headline='价格仍受中期均线压制，反转尚未确认'}
  else if(intradayWeak){nature=price>ma20?'获利回吐偏弱':'弱势减仓';headline='分时承接偏弱，但需结合日线判断是否失效'}
  const shortGrade=score>=72?'较高':score>=58?'中等':score>=45?'中等偏低':'偏低',swingGrade=(price>ma20&&price>ma60)?(score>=70?'较高':'中等偏高'):(score>=55?'中等':'偏低');
  const fmt=n=>round(n).toFixed(2),today=String(last.time).slice(0,10),turnover=num(snap['换手率'])||last.turnover;
  const summary=`${nature}。${price>ma20?'股价仍在MA20上方':'股价位于MA20下方'}，当日量能为5日均量的${round(volumeRatio,2)}倍；相对${primary.name}${relative>=0?'强':'弱'}${Math.abs(round(relative))}个百分点。后续以${fmt(repair)}修复位和${fmt(confirm)}确认位作为验证。`;
  const dims=[['趋势结构',Math.round(trendScore),25],['突破质量',Math.round(breakoutScore),20],['量价承接',Math.round(volumeScore),15],['相对强弱',Math.round(relativeScore),15],['动能指标',Math.round(momentumScore),10],['市场适配',Math.round(marketScore),10],['风险收益',Math.round(rrScore),5]];
  const levels=[['波段压力',fmt(target)],['再确认位',fmt(confirm)],['修复位',fmt(repair)],['当前价',fmt(price),'current'],['日内防守',fmt(dayLow)],['结构失效',fmt(invalidation)]];
  const scenarios=[['#20c997','偏强情景',`守住${fmt(dayLow)}并放量站回${fmt(confirm)}，突破或修复得到确认。`],['#f4bd4b','中性情景',`在${fmt(dayLow)}—${fmt(confirm)}之间震荡，继续等待量价选择方向。`],['#ff5d68','转弱情景',`跌破${fmt(dayLow)}且无法收回；若进一步失守${fmt(invalidation)}，原技术逻辑失效。`]];
  const marketList=[{name:snap['中文简称']||snap['Wind代码'],pct:round(stockPct),relative:round(relative),series:intraday.map(x=>x.close)},{...sh,relative:round(stockPct-sh.pct)},{...sz,relative:round(stockPct-sz.pct)}];if(style)marketList.push({...style,relative:round(stockPct-style.pct)});
  return {name:snap['中文简称']||snap['Wind代码'],code:snap['Wind代码'],price:round(price),delta:round(num(snap['涨跌'])||price-prevClose),pct:round(stockPct),date:`${today} ${intraday.at(-1).time.slice(11,16)} · Wind实时数据`,source:'Wind',phase:stage,headline,summary,relative:pctText(relative),amp:pctText(amplitude),vr:`${round(volumeRatio,2)}×`,rr:round(rr,2).toFixed(2),score,dims,foot:`加分：${price>ma20?'中期结构':'低位空间'}、${volumeRatio<1&&stockPct<0?'缩量回调':'量价配合'}　扣分：${intradayWeak?'分时承接偏弱':'市场环境'}、${phaseType==='false-break'?'突破待修复':'上方压力'}`,open:round(dayOpen),high:round(dayHigh),low:round(dayLow),avg:round(dayVwap),turnover:`${round(turnover,2)}%`,shortGrade,shortText:`短线先看${fmt(repair)}能否收复；放量突破${fmt(confirm)}才算进一步确认。`,swingGrade,swingText:`2—8周首要观察${fmt(target)}压力，只有量价持续配合才打开更高空间。`,levels,scenarios,market:marketList.map(x=>[x.name,x.pct,x.relative,x.series]),intraday:intraday.map((x,i)=>({t:x.time,p:x.close,o:x.open,h:x.high,l:x.low,v:x.volume,a:vwap[i]})),daily:daily.map(x=>({t:x.time,o:x.open,h:x.high,l:x.low,c:x.close,v:x.volume})),indicators:{ma5:round(ma5),ma10:round(ma10),ma20:round(ma20),ma60:round(ma60),ma120:round(ma120),macd:round(macd,4),bollUpper:round(bollUpper),bollMid:round(bollMid),bollLower:round(bollLower)},limits:['不含Level-2挂单撤单与逐笔成交方向','技术潜力评分不代表收益预测']};
}

async function getMarket(code,name,begin,end){const [q,k]=await Promise.all([windCall('index_data','get_index_quote',{windcode:code,begin:'LAST',end:'LAST'}),windCall('index_data','get_index_kline',{windcode:code,begin_date:begin,end_date:end,period:'10',aftime:'0',issusp:'1'})]);const quote=parseQuote(table(q)),daily=parseDaily(table(k));return {name,code,pct:round(marketPct(daily)),series:quote.map(x=>x.close),quote,daily}}

async function analyze(raw){
  const input=normalizeInput(raw),key=input.toUpperCase();const cached=cache.get(key);if(cached&&Date.now()-cached.time<60000)return cached.data;
  const indexes='中文简称,最新成交价,前收盘价,今日开盘价,今日最高价,今日最低价,成交量,成交额,涨跌,涨跌幅,换手率';
  const snapshot=await windCall('stock_data','get_stock_price_indicators',{windcode:input,indexes});const snapshotRows=table(snapshot);if(!snapshotRows.length)throw new Error('未识别到该A股，请输入六位代码或准确简称');
  const code=snapshotRows[0]['Wind代码'];const end=new Date(),begin=new Date(end);begin.setDate(begin.getDate()-230);const beginText=dateText(begin),endText=dateText(end);
  const jobs=[windCall('stock_data','get_stock_quote',{windcode:code,begin:'LAST',end:'LAST'}),windCall('stock_data','get_stock_kline',{windcode:code,begin_date:beginText,end_date:endText,period:'10',aftime:'0',issusp:'1'}),getMarket('000001.SH','上证指数',beginText,endText),getMarket('399001.SZ','深证成指',beginText,endText)];
  const styleCode=/^(300|301)/.test(code)?['399006.SZ','创业板指']:/^(688|689)/.test(code)?['000688.SH','科创50']:null;if(styleCode)jobs.push(getMarket(styleCode[0],styleCode[1],beginText,endText));
  const [quote,kline,sh,sz,style]=await Promise.all(jobs);const result=buildAnalysis(snapshotRows,table(quote),table(kline),{sh,sz},style);cache.set(key,{time:Date.now(),data:result});return result;
}

const server=http.createServer(async(req,res)=>{
  try{
    const ip=clientIp(req);if(lanMode&&!isPrivateIp(ip))return json(res,403,{ok:false,error:'仅允许本机和私有局域网访问'});
    const url=new URL(req.url,`http://${host}:${port}`);
    if(url.pathname==='/api/health')return json(res,200,{ok:true,service:'technical-analysis',wind:true,time:new Date().toISOString()});
    if(url.pathname==='/api/analyze'){if(!rateAllowed(ip))return json(res,429,{ok:false,error:'请求过于频繁，请稍后重试'});if(accessCode&&req.headers['x-access-code']!==accessCode&&url.searchParams.get('key')!==accessCode)return json(res,401,{ok:false,error:'访问码不正确'});const data=await analyze(url.searchParams.get('q'));return json(res,200,{ok:true,data,disclaimer:'数据来源于万得 Wind 金融数据服务。技术分析不构成收益承诺。'})}
    if(url.pathname==='/'||url.pathname==='/index.html'){const html=await readFile(htmlPath);res.writeHead(200,{'content-type':'text/html; charset=utf-8','content-length':html.length,'cache-control':'no-store','x-content-type-options':'nosniff','x-frame-options':'DENY','referrer-policy':'no-referrer'});return res.end(html)}
    return json(res,404,{ok:false,error:'Not found'});
  }catch(error){return json(res,502,{ok:false,error:error.message})}
});

server.listen(port,host,()=>console.log(`技术分析助手已启动：http://${host}:${port}${lanMode?'（仅私有局域网）':''}`));
