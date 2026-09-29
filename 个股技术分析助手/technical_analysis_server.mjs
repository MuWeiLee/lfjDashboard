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
function fiveTier(value){return value>=80?'极高':value>=70?'高':value>=60?'中':value>=50?'低':'极低'}
function oddsIndex(rr){if(rr>=3)return clamp(80+(rr-3)*10,80,100);if(rr>=2)return 70+(rr-2)*10;if(rr>=1.5)return 60+(rr-1.5)*20;if(rr>=1)return 50+(rr-1)*20;return clamp(rr*50,0,49)}
function oddsTier(rr){return fiveTier(oddsIndex(rr))}
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
function quantile(values,q){if(!values.length)return 0;const sorted=[...values].sort((a,b)=>a-b),pos=(sorted.length-1)*q,base=Math.floor(pos),rest=pos-base;return sorted[base]+(sorted[base+1]===undefined?0:rest*(sorted[base+1]-sorted[base]))}
function dailyPct(data,i){if(i<1||!data[i-1].close)return 0;return 100*(data[i].close-data[i-1].close)/data[i-1].close}
function cumulativePct(data,i,n){const start=i-n;if(start<0||!data[start].close)return 0;return 100*(data[i].close-data[start].close)/data[start].close}
function limitThreshold(name,code){if(/^\*?ST/i.test(String(name||'')))return 4.8;if(/\.(BJ)$/.test(code)||/^(4|8|92)/.test(code))return 29;if(/^(300|301|688|689)/.test(code))return 19.5;return 9.8}

function surgeProfile(data,name,code){
  const asOf=String(data.at(-1)?.time||'').slice(0,10);
  if(data.length<6)return {trigger:false,streak:0,limitDays:0,cum3:0,cum5:0,label:'样本不足',name,code,asOf};
  const last=data.length-1,threshold=limitThreshold(name,code);let streak=0;
  for(let i=last;i>=1;i--){if(dailyPct(data,i)>=4.5)streak+=1;else break}
  const limitDays=data.slice(-10).reduce((n,_,j)=>n+(dailyPct(data,data.length-10+j)>=threshold?1:0),0),cum3=cumulativePct(data,last,3),cum5=cumulativePct(data,last,5);
  const trigger=streak>=2||limitDays>=1||cum3>=12||cum5>=18;
  const label=limitDays?`近10日${limitDays}次触及涨停幅度`:streak>=2?`连续${streak}日大涨`:cum5>=18?'5日快速上涨':'未触发连续大涨';
  return {trigger,streak,limitDays,cum3:round(cum3),cum5:round(cum5),threshold,label,name,code,asOf};
}

function featureAt(data,i,marketMap){
  if(i<60||i>=data.length)return null;const d=data[i],prior20=data.slice(i-20,i),prior5=data.slice(i-5,i),prior60=data.slice(i-60,i),avgV=prior5.reduce((s,x)=>s+x.volume,0)/5,ma20=prior20.reduce((s,x)=>s+x.close,0)/20,ma60=prior60.reduce((s,x)=>s+x.close,0)/60,high20=maxOf(prior20,'high');
  const market=marketMap?.get(String(d.time));
  return {ret:dailyPct(data,i),cum5:cumulativePct(data,i,5),vr:avgV?d.volume/avgV:1,above20:d.close>=ma20,above60:d.close>=ma60,breakout:d.close>=high20*.99,range:100*(d.high-d.low)/Math.max(.001,data[i-1].close),marketUp:market?market.close>=market.ma20:null};
}

function historicalAnalogs(data,marketDaily){
  const marketMap=new Map();for(let i=20;i<(marketDaily||[]).length;i++){const window=marketDaily.slice(i-20,i),ma20=window.reduce((s,x)=>s+x.close,0)/20;marketMap.set(String(marketDaily[i].time),{close:marketDaily[i].close,ma20})}
  const last=data.length-1,current=featureAt(data,last,marketMap);if(!current)return {sampleSize:0,confidence:'不足',scope:'该股自身历史',method:'日线数据不足，无法形成可比样本',horizons:[]};
  const ranked=[];for(let i=60;i<=data.length-21;i++){const f=featureAt(data,i,marketMap);if(!f)continue;let distance=Math.abs(f.ret-current.ret)/3+Math.abs(f.cum5-current.cum5)/6+Math.abs(Math.log(Math.max(.05,f.vr)/Math.max(.05,current.vr)))/.45+Math.abs(f.range-current.range)/4;if(f.above20!==current.above20)distance+=1;if(f.above60!==current.above60)distance+=.8;if(f.breakout!==current.breakout)distance+=1.2;if(f.marketUp!==null&&current.marketUp!==null&&f.marketUp!==current.marketUp)distance+=.7;ranked.push({i,distance})}
  ranked.sort((a,b)=>a.distance-b.distance);const selected=[];for(const item of ranked){if(selected.every(x=>Math.abs(x.i-item.i)>=5)){selected.push(item);if(selected.length>=100)break}}
  const usable=selected.filter(x=>x.distance<=5.2);const samples=(usable.length>=15?usable:selected.slice(0,Math.min(30,selected.length)));
  const horizons=[5,10,20].map(days=>{const values=samples.map(x=>100*(data[x.i+days].close-data[x.i].close)/data[x.i].close);return {days,upProb:round(100*values.filter(v=>v>0).length/Math.max(1,values.length),1),downProb:round(100*values.filter(v=>v<=0).length/Math.max(1,values.length),1),median:round(quantile(values,.5)),q25:round(quantile(values,.25)),q75:round(quantile(values,.75))}});
  const sampleSize=samples.length,confidence=sampleSize>=100?'中等':sampleSize>=50?'偏低':sampleSize>=30?'较低':'不足';
  return {sampleSize,confidence,scope:'该股近6年自身历史',method:'按当日涨跌、5日涨幅、量比、振幅、均线/突破状态及市场环境匹配；样本间隔至少5日，未计交易成本。',horizons};
}

function stripDocumentBoilerplate(text){return String(text||'').replace(/[（(][^）)]*(?:由\s*AI|不构成投资建议|仅供参考|公开数据生成)[^）)]*[）)]/gi,' ').replace(/(?:注[：:]?)?以上由\s*AI[^。；]*/gi,' ').replace(/(?:本内容|本文|内容)?不构成投资建议[^。；]*/g,' ').replace(/仅供参考[^。；]*/g,' ')}
function classifyDriver(text){const value=stripDocumentBoilerplate(text);if(/(主力资金净流入|龙虎榜|营业部席位)/.test(value)&&!/(政策|规划|公告称|贷款|融资|展期|担保|订单|合作|并购|重整)/.test(value))return '市场交易反馈';const rules=[['融资与债务进展',/(贷款展期|融资展期|债务展期|债务化解|偿债|流动性|抵押担保|担保进展|再融资)/],['诉讼/风险事项',/(诉讼|仲裁|撤诉|和解协议|赔偿金|被告|原告|立案调查|行政处罚)/],['重整/并购/控制权',/(重整|并购|收购|产业投资人|控制权|国资)/],['战略合作/产业投资',/(战略合作|产业投资|投资.{0,12}(亿元|万元)|入股|增资|合资|供应链合作|车企.{0,8}(投资|合作))/],['业绩变化',/(预增|扭亏|业绩|净利润|营收|同比增长|同比下降)/],['行业竞争格局',/(去宁化|宁王|二线.{0,8}(电池|厂商)|市场份额|份额提升|竞争格局|替代逻辑|国产替代|进口替代|自主可控)/],['重大订单',/(中标|订单|合同|签约)/],['政策与行业催化',/(政策|规划|补贴|行业景气|国务院常务会议|国常会|房地产市场)/],['产品与产业催化',/(涨价|新品|量产|产能|AI(?:芯片|算力|应用|模型|技术|服务器|产业)|人工智能|机器人|算力|低空|储能)/i],['股东与资本运作',/(增持|回购|减持|拍卖|定增|股权激励)/]];for(const [label,re] of rules)if(re.test(value))return label;return '其他相关信息'}
function cleanDocumentText(text){return stripDocumentBoilerplate(String(text||'').replace(/<[^>]+>/g,' ').replace(/https?:\/\/\S+/g,' ')).replace(/[\r\n\t]+/g,'。').replace(/\s+/g,' ').replace(/。{2,}/g,'。').trim()}
function compactFact(text,max=112){const value=String(text||'').replace(/\*+/g,'').replace(/^(?:摘要|导语|正文|消息面|香港万得通讯社报道|观点网讯|财联社.{0,12}日电|据.{0,12}(?:报道|消息))[：:，,]?/,'').replace(/^根据[^：:。]{0,80}(?:异动分析|涨停原因)[^：:。]*[：:]\s*/i,'').replace(/^\d+[、.]\s*/,'').replace(/^方面[：:，,]?/,'').replace(/\s+/g,' ').trim();if(value.length<=max)return value;const clauses=value.split(/[，,]/).map(x=>x.trim()).filter(Boolean);let result='';for(const clause of clauses){const next=result?`${result}，${clause}`:clause;if(next.length>max)break;result=next}return result?result.replace(/[；;：:]$/,'')+'。':value}
function eventDateValue(value){const text=String(value||'');let match=text.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);if(!match)match=text.match(/\b(20\d{2})(\d{2})(\d{2})\b/);return match?Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3])):NaN}
function isRecentEvent(value,asOf,days=3){const eventDate=eventDateValue(value),analysisDate=eventDateValue(asOf);if(!Number.isFinite(eventDate)||!Number.isFinite(analysisDate))return false;const age=(analysisDate-eventDate)/86400000;return age>=0&&age<days}
function eventQueryRange(asOf,days=3){const endValue=eventDateValue(asOf);if(!Number.isFinite(endValue))return '最近3天';const start=new Date(endValue-(days-1)*86400000),end=new Date(endValue),fmt=d=>`${d.getUTCFullYear()}年${d.getUTCMonth()+1}月${d.getUTCDate()}日`;return `${fmt(start)}至${fmt(end)}`}
function normalizeEntityText(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/[\s·•._－—-]/g,'')}
function isCompanyDocument(item,profile){const title=normalizeEntityText(item.title),body=normalizeEntityText(item.content),name=normalizeEntityText(profile.name),shortName=name.replace(/(?:股份有限公司|有限责任公司)$/,'').replace(/[a-z]$/,'').replace(/^st|^\*st/,'');const code=String(profile.code||'').split('.')[0],nameAliases=[name,shortName].filter(x=>x&&x.length>=2),titleMatched=nameAliases.some(alias=>title.includes(alias))||title.includes(code);if(item.doc_type==='announcement')return titleMatched;return titleMatched||nameAliases.some(alias=>body.includes(alias))||body.includes(code)}
function extractCoreFact(item,company){
  const body=cleanDocumentText(item.content),fromBody=body.length>=24,source=fromBody?body:String(item.title||''),allSentences=source.split(/[。！？!?；]/).map(x=>x.trim()).filter(x=>x.length>=10),sentences=allSentences.filter(x=>x.length<=220);
  const eventTerms=/(投资|入股|增资|合作|供应|转向|分流|中标|订单|合同|营收|净利润|增长|下降|出货量|毛利率|产能|量产|涨价|储能|市场份额|国产替代|进口替代|自主可控|改革|并购|收购|控制权|回购|减持|政策|和解|撤诉|赔偿|贷款|融资|展期|担保|债务)/,actionTerms=/(宣布|斥资|增资|持有|成为|供应|搭载|转向|分流|达到|同比|签署|中标|落地|生效|撤回|展期|担保)/,numberTerms=/(\d+(?:[,.]\d+)?\s*(?:亿元|万元|亿|万|%|个百分点|GWh|MW|GW|吨|家|倍|股份))/i,riskImpact=/(预计.{0,20}(归母净利润|损益).{0,20}影响|涉案.{0,8}金额|达成和解|撤回起诉)/,noise=/(免责声明|风险提示|本文不构成|不构成投资建议|由\s*AI|公开数据生成|仅供参考|责任编辑|编辑|校对|制作|点击查看|来源：|记者：)/i,priceReaction=/(股价|市值|涨停|连板|大涨|涨超|下跌|跌超|报\d|成交额|盘中|集体跟涨|收盘|概念股|主力资金|净流入|资金流入|资金流出)/,genericClaim=/(全力.{0,6}冲刺|早已不是|步子越迈越大|最大的赢家|泼天机遇)/;
  const typeTerms={'诉讼/风险事项':/(诉讼|仲裁|撤诉|和解|赔偿|涉案|立案|处罚)/,'重整/并购/控制权':/(重整|并购|收购|控制权|产业投资人|国资)/,'融资与债务进展':/(贷款|融资|展期|债务|偿债|流动性|抵押|担保)/,'战略合作/产业投资':/(战略合作|产业投资|投资.{0,12}(亿元|万元)|入股|增资|合资|大基金)/,'行业竞争格局':/(市场份额|竞争格局|国产替代|进口替代|自主可控|高端靶材|半导体靶材|行业景气)/,'业绩变化':/(业绩|营收|营业收入|净利润|毛利率|同比增长|同比下降|扭亏|预增)/,'重大订单':/(中标|订单|合同|签约)/,'产品与产业催化':/(涨价|新品|量产|产能|人工智能|机器人|算力|低空|储能|产品)/,'政策与行业催化':/(政策|规划|补贴|行业景气|国务院|国常会|房地产)/,'股东与资本运作':/(增持|回购|减持|拍卖|定增|股权激励)/}[item.driver];
  if(item.driver==='融资与债务进展'&&/(贷款|融资)/.test(source)&&/展期|延长/.test(source)){const companyName=String(company||'公司').normalize('NFKC').replace(/\s+/g,''),amount=source.match(/(?:实际借款本金|贷款余额|担保本金金额(?:为)?)[^\d]{0,8}([\d,.]+\s*亿元)/)?.[1]||source.match(/([\d,.]+\s*亿元)(?:的)?贷款(?:期限)?(?:继续延长|展期)/)?.[1]||'',term=source.match(/(?:继续延长|展期)\s*([\d.]+\s*年)/)?.[1]||'',guarantee=/抵押担保|提供抵押/.test(source);return {text:`${companyName}相关子公司${amount?`${amount}`:''}贷款获展期${term?term:''}${guarantee?'，并由控股子公司继续提供抵押担保':''}。`,fromBody,score:32}}
  if(item.driver==='政策与行业催化'&&/稳定房地产市场/.test(source)){const companyName=String(company||'该股').normalize('NFKC').replace(/\s+/g,''),reaction=/(房地产板块|地产股).{0,20}(?:走强|领涨|涨停潮)/.test(source)||/(?:走强|领涨|涨停潮).{0,20}(房地产板块|地产股)/.test(source);return {text:`国常会提出研究出台稳定房地产市场政策${reaction?`，地产板块随后走强，${companyName}受到资金关注`:''}。`,fromBody,score:30}}
  if(item.driver==='政策与行业催化'){const priority=allSentences.find(x=>/(国务院常务会议|国常会|政策|规划|补贴)/.test(x)&&!noise.test(x));if(priority)return {text:compactFact(priority,128),fromBody,score:24}}
  if(item.driver==='诉讼/风险事项'){const priority=sentences.find(x=>/(预计.{0,30}(归母净利润|损益).{0,30}\d|对上市公司.{0,20}(利润|损益).{0,30}\d)/.test(x))||sentences.find(x=>/涉案.{0,12}金额/.test(x));if(priority){const impact=priority.match(/预计对上市公司.{0,45}?影响为[^，。；]{1,35}/)?.[0];return {text:impact||compactFact(priority),fromBody,score:30}}}
  const specialRules={
    '重整/并购/控制权':{terms:/(重整|并购|收购|控制权|产业投资人|国资)/,actions:/(拟|完成|通过|受让|转让|取得|终止|获批|签署)/},
    '融资与债务进展':{terms:/(贷款|融资|展期|债务|偿债|流动性|抵押|担保)/,actions:/(获得|申请|展期|延长|偿还|兑付|提供|解除|新增)/},
    '战略合作/产业投资':{terms:/(战略合作|产业投资|入股|增资|合资|供应链合作|投资)/,actions:/(签署|达成|投资|入股|增资|设立|建设|共同)/},
    '业绩变化':{terms:/(营业收入|营收|归母净利润|净利润|扣非净利润|毛利率|业绩预告|扭亏|预增|预亏)/,actions:/(同比|增长|下降|增加|减少|扭亏|亏损|盈利)/},
    '行业竞争格局':{terms:/(市场份额|份额提升|竞争格局|国产替代|进口替代|自主可控|供需格局|行业集中度)/,actions:/(提升|扩大|替代|突破|领先|转向|加速)/},
    '重大订单':{terms:/(中标|订单|合同|签约|采购项目)/,actions:/(中标|获得|签订|签署|履行|交付|确认)/},
    '产品与产业催化':{terms:/(新品|新产品|量产|产能|投产|涨价|人工智能|机器人|算力|低空|储能|产品认证)/,actions:/(发布|推出|量产|投产|扩产|涨价|通过|认证|供货)/},
    '股东与资本运作':{terms:/(增持|回购|减持|拍卖|定增|股权激励|员工持股)/,actions:/(拟|完成|实施|终止|注销|授予|认购|减持|增持)/},
    '诉讼/风险事项':{terms:/(诉讼|仲裁|处罚|立案调查|赔偿|冻结|违约|撤诉|和解)/,actions:/(收到|涉及|判决|裁定|处罚|立案|冻结|和解|撤回)/},
    '市场交易反馈':{terms:/(主力资金|龙虎榜|营业部席位|净流入|净卖出)/,actions:/(流入|流出|买入|卖出|上榜)/}
  },specialRule=specialRules[item.driver];
  if(specialRule){let selected='',selectedScore=-Infinity;for(const sentence of allSentences.filter(x=>x.length<=320)){let score=0;if(specialRule.terms.test(sentence))score+=14;else continue;if(specialRule.actions.test(sentence))score+=6;const numberCount=(sentence.match(/\d+(?:[,.]\d+)?\s*(?:亿元|万元|亿|万|%|个百分点|GWh|MW|GW|吨|家|倍|股份|股|元)/gi)||[]).length;score+=Math.min(10,numberCount*3);if(company&&normalizeEntityText(sentence).includes(normalizeEntityText(company)))score+=4;if(sentence.length>=24&&sentence.length<=170)score+=3;if(noise.test(sentence))score-=18;if(item.driver!=='市场交易反馈'&&priceReaction.test(sentence))score-=8;if(score>selectedScore){selected=sentence;selectedScore=score}}if(selected&&selectedScore>=14)return {text:compactFact(selected,136),fromBody:fromBody&&selectedScore>=18,score:selectedScore}}
  let best='',bestScore=-Infinity;for(const sentence of sentences){let score=0;if(company&&sentence.includes(company))score+=5;if(eventTerms.test(sentence))score+=4;if(actionTerms.test(sentence))score+=4;if(numberTerms.test(sentence))score+=5;if(eventTerms.test(sentence)&&numberTerms.test(sentence))score+=3;if(typeTerms)score+=typeTerms.test(sentence)?10:-6;if(item.driver==='诉讼/风险事项'&&riskImpact.test(sentence))score+=10;if(sentence.length>=22&&sentence.length<=140)score+=2;if(noise.test(sentence))score-=16;if(priceReaction.test(sentence))score-=12;if(genericClaim.test(sentence))score-=6;if(sentence===item.title)score-=3;if(score>bestScore){bestScore=score;best=sentence}}
  let factText=compactFact(best||item.title||'未提取到正文事实');
  if(item.driver==='行业竞争格局'&&best){const focused=best.split(/[，,；;]/).map(x=>x.trim().replace(/^系/,'')).filter(x=>x&&typeTerms.test(x)&&!priceReaction.test(x));if(focused.length)factText=compactFact(focused.join('，'))}
  return {text:factText,fromBody:fromBody&&bestScore>=4,score:bestScore};
}
function catalystAnalysis(profile,documents){
  if(!profile.trigger){const eventSummaryItems=[{type:'事件状态',text:'近期没有达到需要进行上涨归因的价格触发条件。'}];return {...profile,hasVerifiedEvent:false,headline:'近期未触发连续大涨或涨停结构',drivers:[],technical:'未达到连续大涨、近10日涨停或5日快速上涨的触发条件。',eventSummaryItems,eventSummary:eventSummaryItems.map(x=>`${x.type}：${x.text}`).join('\n'),conclusionLevel:'未触发',supportReason:'当前事件信息只作为背景，不构成连续上涨驱动的有效证据。'}}
  const items=[...(documents?.announcements?.items||[]),...(documents?.news?.items||[])].filter(x=>isRecentEvent(x.date,profile.asOf,3)&&isCompanyDocument(x,profile)).map(x=>({...x,driver:classifyDriver(`${x.title||''} ${x.content||''}`)})).sort((a,b)=>String(b.date||'').localeCompare(String(a.date||''))||num(b.relevance)-num(a.relevance));
  if(!items.length){const retrievalFailed=(documents?.errors||[]).length>0,eventSummaryItems=[{type:'事件状态',text:retrievalFailed?'新闻或公告接口本次未完整返回，暂时无法确认最近3日事件。':'最近3个自然日内未检索到与该公司明确相关的公告、新闻或资讯。'}];return {...profile,hasVerifiedEvent:false,headline:retrievalFailed?`${profile.label}，事件数据暂不可用`:`${profile.label}，近3日无可核验事件`,drivers:[],technical:'事件驱动仅统计分析日当天及此前两个自然日，日期缺失、更早或无法匹配公司的内容不纳入。',eventSummaryItems,eventSummary:eventSummaryItems.map(x=>`${x.type}：${x.text}`).join('\n'),conclusionLevel:retrievalFailed?'数据异常':'无',supportReason:''}}
  const seen=new Set(),enriched=[];for(const item of items){const key=`${item.driver}|${item.title}`;if(seen.has(key))continue;seen.add(key);const fact=extractCoreFact(item,profile.name);enriched.push({type:item.driver,title:item.title||'未命名资料',date:item.date||'',url:item.url||'',source:item.doc_type==='announcement'?'公司公告':'财经新闻',relevance:num(item.relevance),fact:fact.text,fromBody:fact.fromBody,factScore:fact.score});if(enriched.length>=24)break}
  const rankedLinks=[...enriched].sort((a,b)=>((b.source==='公司公告'?20:0)+(!['其他相关信息','市场交易反馈'].includes(b.type)?10:0)+(b.fromBody?3:0)+b.relevance)-((a.source==='公司公告'?20:0)+(!['其他相关信息','市场交易反馈'].includes(a.type)?10:0)+(a.fromBody?3:0)+a.relevance)),selectedLinks=[];for(const item of rankedLinks){const titleKey=normalizeEntityText(item.title);if(selectedLinks.some(x=>{const prior=normalizeEntityText(x.title);return Math.min(prior.length,titleKey.length)>=12&&(prior.includes(titleKey)||titleKey.includes(prior))}))continue;selectedLinks.push(item);if(selectedLinks.length>=4)break}const drivers=selectedLinks.map(({fact,fromBody,factScore,relevance,...driver})=>driver),evidence=enriched.filter(x=>x.factScore>=4&&!/(编辑|校对|制作|责任编辑)/.test(x.fact)),positive=evidence.filter(x=>!['诉讼/风险事项','其他相关信息','市场交易反馈'].includes(x.type)),riskItems=evidence.filter(x=>x.type==='诉讼/风险事项'),announcementCount=positive.filter(x=>x.source==='公司公告').length,bodyEvidenceCount=positive.filter(x=>x.fromBody).length;
  const hardTypes=new Set(['重整/并购/控制权','融资与债务进展','战略合作/产业投资','业绩变化','重大订单','产品与产业催化']),hardCount=new Set(positive.filter(x=>hardTypes.has(x.type)).map(x=>x.type)).size,typeCount=new Set(positive.map(x=>x.type)).size;
  const groups=new Map();for(const item of positive){if(!groups.has(item.type))groups.set(item.type,[]);groups.get(item.type).push(item)}
  const typeRank={'战略合作/产业投资':8,'重整/并购/控制权':8,'融资与债务进展':8,'重大订单':7,'业绩变化':7,'产品与产业催化':6,'行业竞争格局':5,'政策与行业催化':4,'股东与资本运作':3,'市场交易反馈':1};
  const eventSummaryItems=[...groups].sort((a,b)=>(typeRank[b[0]]||0)-(typeRank[a[0]]||0)).slice(0,3).map(([type,group])=>{const best=[...group].sort((a,b)=>b.factScore-a.factScore)[0];return {type,text:best.fact}});
  const riskFact=riskItems.length?[...riskItems].sort((a,b)=>b.factScore-a.factScore)[0].fact:'';if(riskFact)eventSummaryItems.push({type:'风险事项',text:riskFact});
  if(!eventSummaryItems.length)eventSummaryItems.push({type:'事件状态',text:'未检索到与本轮上涨时点相匹配的公司公告或高相关资讯。'});
  const eventSummary=eventSummaryItems.map(x=>`${x.type}：${x.text}`).join('\n');
  let conclusionLevel='偏弱',supportReason='检索到的主要是媒体资讯或宽泛题材，没有公司公告提供交叉验证，对上涨逻辑的支撑较弱。';
  if(announcementCount>=1&&hardCount>=2&&bodyEvidenceCount>=2){conclusionLevel='较强';supportReason=`${announcementCount}条相关公司公告与${hardCount}条实质事项得到正文事实支持，事件具有较明确的公司层面依据。`}
  else if(announcementCount>=1&&hardCount>=1&&bodyEvidenceCount>=1){conclusionLevel='中等';supportReason=`有公司公告和正文中的实质事项支持，但证据数量或事件类型仍较集中。`}
  else if(hardCount>=2&&typeCount>=2&&bodyEvidenceCount>=3){conclusionLevel='中等';supportReason=`正文可确认${typeCount}类实质事件，多类经营与产业事实能够相互印证，但缺少直接公司公告交叉验证。`}
  else if(positive.length&&typeCount>=2&&bodyEvidenceCount>=2){conclusionLevel='中等偏弱';supportReason=`正文可确认${typeCount}类相关事件，但缺少公司公告交叉验证，支撑主要来自行业资讯。`}
  else if(enriched.length){conclusionLevel='偏弱';supportReason=bodyEvidenceCount?'正文仅能确认单一方向事件，且缺少公司级证据，支撑有限。':'未取得足够正文事实，当前判断主要依赖标题线索，可信度较低。'}
  if(riskItems.length&&conclusionLevel==='较强')conclusionLevel='中等';
  if(riskItems.length)supportReason+=` 同时检索到${riskItems.length}项公司风险事项，已作为反向证据纳入判断。`;
  return {...profile,hasVerifiedEvent:drivers.length>0,headline:drivers.length?`${profile.label}，近3日存在可核验事件候选`:`${profile.label}，近3日未找到可核验事件`,drivers,technical:`近3日${pctText(profile.cum3)}、近5日${pctText(profile.cum5)}；事件仅取分析日当天及此前两个自然日，并依据新闻与公告正文总结。`,eventSummaryItems,eventSummary,conclusionLevel,supportReason};
}
function distributionDayCount(data){let count=0;for(let i=Math.max(6,data.length-12);i<data.length;i++){const prior=data.slice(i-5,i),avgVolume=prior.reduce((s,x)=>s+x.volume,0)/Math.max(1,prior.length),d=data[i],location=(d.close-d.low)/Math.max(.001,d.high-d.low),ret=dailyPct(data,i);if(d.volume>avgVolume*1.15&&ret<1.5&&location<.48)count+=1}return count}

function parseQuote(rows){return rows.map(r=>({time:r.TIME,open:num(r.OPEN),close:num(r.MATCH),high:num(r.HIGH),low:num(r.LOW),amount:num(r.TURNOVER),volume:num(r.VOLUME),turnover:num(r.CHANGEHANDRATE),avg:num(r.AVPRICE)}))}
function parseDaily(rows){return rows.map(r=>({time:r.TIME,open:num(r.OPEN),close:num(r.MATCH),high:num(r.HIGH),low:num(r.LOW),amount:num(r.TURNOVER),volume:num(r.VOLUME),turnover:num(r.CHANGEHANDRATE),avg:num(r.AVPRICE)}))}
function marketPct(daily){if(daily.length<2)return 0;const p=daily.at(-2).close,c=daily.at(-1).close;return p?100*(c-p)/p:0}
function dynamicVwap(points){let a=0,v=0;return points.map(p=>{a+=p.amount;v+=p.volume;return v?a/v:p.avg||p.close})}

function buildAnalysis(snapshotRows,stockQuote,stockDaily,markets,styleMarket,documents){
  const snap=snapshotRows[0]||{},allDaily=parseDaily(stockDaily),daily=allDaily.slice(-120),intraday=parseQuote(stockQuote),last=daily.at(-1),prev=daily.at(-2),closes=daily.map(x=>x.close),volumes=daily.map(x=>x.volume);
  if(!last||!intraday.length)throw new Error('Wind未返回足够的个股行情数据');
  const price=num(snap['最新成交价'])||last.close,prevClose=num(snap['前收盘价'])||prev?.close||price,stockPct=num(snap['涨跌幅'])||100*(price-prevClose)/prevClose;
  const ma5=sma(closes,5),ma10=sma(closes,10),ma20=sma(closes,20),ma60=sma(closes,60),ma120=sma(closes,120),vol5=sma(volumes.slice(0,-1),5),vol20=sma(volumes.slice(0,-1),20),volumeRatio=vol5?last.volume/vol5:1;
  const e12=ema(closes,12),e26=ema(closes,26),dif=closes.map((_,i)=>e12[i]-e26[i]),dea=ema(dif,9),macd=dif.at(-1)-dea.at(-1);
  const last20=closes.slice(-20),bollMid=sma(closes,20),bollStd=std(last20),bollUpper=bollMid+2*bollStd,bollLower=bollMid-2*bollStd;
  const prior20=daily.slice(-21,-1),prior60=daily.slice(-61,-1),prior20High=maxOf(prior20,'high'),prior60High=maxOf(prior60,'high'),prior20Low=minOf(prior20,'low'),low10=minOf(daily.slice(-10),'low'),low20=minOf(daily.slice(-20),'low'),high120=maxOf(daily,'high'),low120=minOf(daily,'low'),rangePosition=(price-low120)/Math.max(.001,high120-low120),runup60=100*(price-minOf(prior60,'low'))/Math.max(.001,minOf(prior60,'low')),distributionDays=distributionDayCount(daily);
  const recentBreak=daily.slice(-5,-1).some((d,i)=>d.high>maxOf(daily.slice(Math.max(0,daily.length-25+i),daily.length-5+i),'high')*1.005);
  const vwap=dynamicVwap(intraday),dayOpen=intraday[0].open,dayHigh=maxOf(intraday,'high'),dayLow=minOf(intraday,'low'),dayAmount=intraday.reduce((s,x)=>s+x.amount,0),dayVolume=intraday.reduce((s,x)=>s+x.volume,0),dayVwap=dayVolume?dayAmount/dayVolume:num(snap['最新均价'])||last.avg;
  const belowVwap=intraday.filter((p,i)=>p.close<vwap[i]).length/intraday.length,closeLocation=(price-dayLow)/Math.max(.001,dayHigh-dayLow),amplitude=100*(dayHigh-dayLow)/prevClose;
  const breakoutMargin=100*(price-prior20High)/Math.max(.001,prior20High),highFadePct=100*(dayHigh-price)/Math.max(.001,dayHigh),vwapGapPct=100*(price-dayVwap)/Math.max(.001,dayVwap),upperReversalShare=(dayHigh-Math.max(dayOpen,price))/Math.max(.001,dayHigh-dayLow);
  const sh=markets.sh,sz=markets.sz,style=styleMarket||null,primary=style||(/\.SH$/.test(snap['Wind代码']||'')?sh:sz),relative=stockPct-primary.pct;
  const highZone=rangePosition>.72||runup60>35,strongRecovery=stockPct<0&&closeLocation>.62&&dayLow<=Math.max(ma10,ma20)*1.01,volumeReversal=volumeRatio>=1.3&&closeLocation<.35&&highFadePct>=3&&upperReversalShare>.45,breakoutRejected=dayHigh>prior20High*1.01&&price<=prior20High*1.015&&volumeReversal,distributionEvidence=highZone&&distributionDays>=2&&belowVwap>.55&&stockPct<3&&closeLocation<.55,breakoutFailed=recentBreak&&price<prior20High*.97&&(price<ma20||price<prior20Low*1.01),trendDamaged=price<prior20Low*.99&&price<ma20&&price<ma60&&ma20<=ma60,bottomZone=rangePosition<.3&&price<=minOf(prior60,'low')*1.12,bottomRepair=bottomZone&&(ma5>=ma10||macd>0)&&volumeRatio<=1.15,strongWashout=price>=ma20*.985&&price>=ma60&&volumeRatio<.9&&(strongRecovery||closeLocation>.48);
  let stage='正常回踩 · 观察',phaseType='pullback';
  if(distributionEvidence){stage='高位派发 · 放量滞涨';phaseType='distribution'}
  else if(breakoutFailed){stage='突破失效 · 平台失守';phaseType='failed'}
  else if(trendDamaged){stage='趋势破坏 · 支撑跌破';phaseType='damage'}
  else if(breakoutRejected){stage='突破遇阻 · 等待承接';phaseType='rejection'}
  else if(price>prior20High*1.01&&volumeRatio>1.15&&closeLocation>=.55&&vwapGapPct>=-.5){stage='确认突破 · 等待跟随';phaseType='breakout'}
  else if(strongWashout){stage='强势洗盘 · 快速收复';phaseType='washout'}
  else if(bottomRepair){stage='低位筑底 · 反转待确认';phaseType='bottoming'}
  else if(price>=prior20High*.98&&price>=ma20){stage='准备突破 · 临界区';phaseType='ready'}
  else if(recentBreak&&price<prior20High&&price>=ma20*.97){stage='假突破 · 待修复';phaseType='false-break'}
  else if(price<ma20&&price<ma60){stage='弱势结构 · 尚未反转';phaseType='weak'}
  else if(price>=ma20&&volumeRatio<1){stage='缩量回踩 · 趋势未破';phaseType='pullback'}
  const trendScore=clamp((price>ma20?9:3)+(price>ma60?8:2)+(ma20>ma60?5:2)+(ma5>ma10?3:1),0,25);
  const breakoutScore=clamp(phaseType==='breakout'?19:phaseType==='ready'?16:phaseType==='washout'?14:phaseType==='pullback'?13:phaseType==='rejection'?9:phaseType==='false-break'?9:phaseType==='bottoming'?8:phaseType==='distribution'?4:phaseType==='failed'?3:phaseType==='damage'?2:6,0,20);
  const volumeBase=volumeReversal?4:volumeRatio>=1.15&&stockPct>0&&closeLocation>=.55&&vwapGapPct>=-.5?13:volumeRatio>=1.15&&stockPct>0?7:volumeRatio<.9&&stockPct<0?11:8;
  const volumeScore=clamp(volumeBase+(closeLocation>.65?2:closeLocation>.55?1:0),0,15);
  const relativeBonus=relative>1?2:relative>.3?1:0,relativeScore=clamp(8+relative*1.8+relativeBonus,0,15);
  const momentumScore=clamp(5+(macd>0?3:-1)+(price>bollMid?2:0)+(vwapGapPct>=0?1:-2)+(closeLocation>.55?1:closeLocation<.35?-2:0),0,10);
  const marketAvg=(sh.pct+sz.pct)/2,marketScore=clamp(6+marketAvg*1.5+(primary.pct>0?2:0),0,10);
  const repair=nearestAbove([ma5,ma10,ma20,dayVwap],price,Math.max(ma5,ma10,ma20)),confirm=nearestAbove([dayHigh,prior20High,prior60High,bollUpper],repair,prior20High),target=nearestAbove([prior20High,prior60High,bollUpper,maxOf(daily,'high')],confirm,prior60High);
  const invalidation=price>ma20?Math.min(ma20,low10):Math.min(low10,bollLower),risk=Math.max(.01,price-invalidation),reward=Math.max(.01,target-price),rr=reward/risk,rrScore=clamp(rr>=2?5:rr>=1.3?4:rr>=.8?3:1,0,5);
  const history=historicalAnalogs(allDaily,primary.daily||[]),surge=catalystAnalysis(surgeProfile(allDaily,snap['中文简称'],snap['Wind代码']),documents);
  const upsidePct=100*Math.max(0,target-price)/price,downsidePct=100*Math.max(0,price-invalidation)/price,minAcceptableRR=1.5,maxValuePrice=(target+minAcceptableRR*invalidation)/(1+minAcceptableRR),history20=history.horizons.find(x=>x.days===20),probSupport=history20&&history.sampleSize>=15?history20.upProb:null;
  let buyGrade=rr>=2?'较高':rr>=1.5?'尚可':rr>=1?'偏低':'较差';if(probSupport!==null&&probSupport<45&&buyGrade==='较高')buyGrade='尚可';if(probSupport!==null&&probSupport<40)buyGrade='偏低';if(['rejection','false-break','bottoming','weak'].includes(phaseType)&&buyGrade==='较高')buyGrade='尚可';if(['distribution','failed','damage'].includes(phaseType))buyGrade='较差';
  const priceRoomPct=100*(maxValuePrice-price)/price,buyVerdict=phaseType==='rejection'?'潜在空间仍在，但当日突破没有收住；先等平台承接和均价修复，不能只因赔率较高就立即追入。':price<=maxValuePrice?`当前仍在${minAcceptableRR}倍最低风险收益区间内，但需等待技术确认。`:`当前已高于${minAcceptableRR}倍风险收益上限，继续追价的技术性价比偏低。`,buyValue={grade:buyGrade,rr:round(rr,2),upsidePct:round(upsidePct),downsidePct:round(downsidePct),minAcceptableRR,maxValuePrice:round(maxValuePrice),priceRoomPct:round(priceRoomPct),historicalSupport:probSupport,verdict:buyVerdict};
  const historyWeight=history.sampleSize>=100?1:history.sampleSize>=50?.75:history.sampleSize>=30?.55:history.sampleSize>=15?.35:0;
  const horizonWeights={5:.25,10:.35,20:.40},medianRanges={5:5,10:8,20:12};
  const historyComponents=history.horizons.map(item=>{const probabilityScore=clamp((item.upProb-30)/4,0,10),medianScore=clamp(5+item.median*5/medianRanges[item.days],0,10),combinedScore=.8*probabilityScore+.2*medianScore,weight=horizonWeights[item.days]||0;return {days:item.days,upProb:item.upProb,median:item.median,probabilityScore:round(probabilityScore,1),medianScore:round(medianScore,1),combinedScore:round(combinedScore,1),weight}});
  const historyRawScore=historyComponents.reduce((sum,item)=>sum+item.combinedScore*item.weight,0),historyScore=clamp(5+(historyRawScore-5)*historyWeight,0,10),historyLabel=historyWeight>=.75?'较可信':historyWeight>=.55?'有限支持':historyWeight>0?'仅供参考':'不参与方向判断';
  const historyValidation={score:round(historyScore,1),max:10,rawScore:round(historyRawScore,1),confidenceWeight:historyWeight,label:historyLabel,components:historyComponents,note:'5日、10日、20日分别占25%、35%、40%；各周期由上涨条件频率占80%、中位收益占20%形成连续分，再按样本量向中性5分收缩。'};
  const adjustedTrend=trendScore*20/25,adjustedBreakout=breakoutScore*15/20;
  const directionalPoints=adjustedTrend+adjustedBreakout+volumeScore+relativeScore+momentumScore+marketScore+historyScore,directionalRaw=100*directionalPoints/95;
  const historyWeak=history20&&history.sampleSize>=30&&history20.upProb<45,phaseWinCap={distribution:39,failed:34,damage:29,rejection:59,'false-break':54,weak:49,bottoming:54,ready:74,washout:74,pullback:79,breakout:95};
  const winScore=Math.round(Math.min(directionalRaw,phaseWinCap[phaseType]??100,historyWeak?59:100)),oddsScore=Math.round(oddsIndex(rr)),winLevel=fiveTier(winScore),oddsLevel=oddsTier(rr),score=winScore,opportunityScore=Math.round(directionalPoints+rrScore);
  const winRank={极低:0,低:1,中:2,高:3,极高:4}[winLevel],oddsRank={极低:0,低:1,中:2,高:3,极高:4}[oddsLevel];
  if(winRank<=1){buyGrade=oddsRank>=2?'等待确认':'暂不买入';buyValue.grade=buyGrade;buyValue.verdict=oddsRank>=2?'潜在空间尚可，但技术胜率处于低档；先等结构转强，不能只因赔率较高就买入。':'胜率和赔率都处于低档，当前不满足技术买入条件。'}
  else if(winRank>=3&&oddsRank<=1){buyGrade='不宜追价';buyValue.grade=buyGrade;buyValue.verdict='技术胜率处于高档，但赔率处于低档，说明剩余空间不足以覆盖回撤风险，应等待更合适的价格。'}
  else if(winRank>=3&&oddsRank>=3){buyGrade='合理参与';buyValue.grade=buyGrade;buyValue.verdict='胜率和赔率都处于高档，代表具备技术参与条件；这不是立即买入指令，仍需关键位确认并遵守结构失效位。'}
  else if(winRank>=2&&oddsRank>=2){buyGrade='谨慎参与';buyValue.grade=buyGrade;buyValue.verdict='胜率和赔率至少达到中档，代表可以继续观察并等待触发，但不适合无条件追入。'}
  else{buyGrade='暂不买入';buyValue.grade=buyGrade;buyValue.verdict='胜率或赔率至少有一项处于低档，当前不满足理想买入条件，优先等待改善。'}
  const oddsVerdict=rr>=3?`到压力位的潜在空间约为失效风险的${round(rr,2)}倍，赔率处于极高档；但赔率高不代表上涨胜率高。`:rr>=2?`到压力位的潜在空间约为失效风险的${round(rr,2)}倍，赔率处于高档；仍需结合技术胜率和结构确认。`:rr>=1.5?`潜在空间能够覆盖失效风险，赔率处于中档，但安全垫并不充裕。`:rr>=1?`潜在空间仅略高于失效风险，赔率处于低档，追价容错较小。`:`潜在空间小于失效风险，赔率处于极低档，当前价格缺乏足够安全垫。`;
  buyValue.action=buyGrade;buyValue.grade=`赔率${oddsLevel}`;buyValue.oddsLevel=oddsLevel;buyValue.verdict=oddsVerdict;
  const intradayWeak=(belowVwap>.62&&closeLocation<.4)||volumeReversal;
  let nature='正常回踩 / 获利回吐',headline='结构仍需市场确认';
  if(phaseType==='breakout'){nature='有效突破';headline='量价突破成立，继续观察跟随买盘'}
  else if(phaseType==='rejection'){nature='放量冲高回落';headline='盘中突破未能收住，等待平台承接确认'}
  else if(phaseType==='washout'){nature='强势洗盘';headline='趋势仍在且回调缩量，日内出现收复证据'}
  else if(phaseType==='distribution'){nature='高位派发风险';headline='高位反复放量滞涨，筹码松动风险上升'}
  else if(phaseType==='failed'){nature='突破失效';headline='价格跌回平台并失守关键支撑，原突破逻辑失效'}
  else if(phaseType==='damage'){nature='趋势破坏';headline='日线支撑与中期均线同时失守，需按弱势结构处理'}
  else if(phaseType==='bottoming'){nature='低位筑底';headline='低位出现修复迹象，但趋势反转仍未确认'}
  else if(phaseType==='false-break'){nature=intradayWeak?'假突破风险上升':'突破回踩待确认';headline='突破后回落，进入关键修复窗口'}
  else if(phaseType==='weak'){nature='弱势减仓 / 筑底未成';headline='价格仍受中期均线压制，反转尚未确认'}
  else if(intradayWeak){nature=price>ma20?'获利回吐偏弱':'弱势减仓';headline='分时承接偏弱，但需结合日线判断是否失效'}
  const shortGrade=score>=72?'较高':score>=58?'中等':score>=45?'中等偏低':'偏低',swingGrade=(price>ma20&&price>ma60)?(score>=70?'较高':'中等偏高'):(score>=55?'中等':'偏低');
  const fmt=n=>round(n).toFixed(2),today=String(last.time).slice(0,10),turnover=num(snap['换手率'])||last.turnover;
  const phaseMeaning=phaseType==='distribution'?'股价处在阶段高位，近期多次放量却未能继续上涨，说明高位筹码开始松动':phaseType==='failed'?'此前突破后又跌回原平台，关键支撑没有守住':phaseType==='damage'?'价格已经跌破近期低点并落到中期均线下方，原有上升结构被破坏':phaseType==='rejection'?'中期趋势尚未破坏，但盘中越过平台后大部分涨幅没有保留，只能视为突破尝试遇阻，单凭一天也不能直接认定为出货':phaseType==='breakout'?'价格已经越过近期平台，并且收盘位置和成交量共同支持突破':phaseType==='washout'?'中期趋势还没有被破坏':phaseType==='bottoming'?'股价仍处在阶段低位，短期走势开始修复，但还不能确认反转':phaseType==='ready'?'股价已经靠近平台上沿，但还没有形成有效突破':phaseType==='false-break'?'此前冲过压力位后又跌回平台，目前处在修复窗口':phaseType==='weak'?'价格仍受中期均线压制，当前反弹还不能证明趋势已经反转':'价格仍在中期趋势支撑附近，当前更像上涨后的正常消化';
  const volumeMeaning=volumeReversal?'成交显著放大但涨幅大幅回吐，说明高位换手和兑现压力明显，放量本身不能视为承接':stockPct<0&&volumeRatio<.85?'下跌时成交量明显收缩，说明主动抛售没有集中释放':stockPct<0&&volumeRatio>1.2?'下跌同时成交量明显放大，说明抛压较重':stockPct>0&&volumeRatio>1.2?'上涨得到成交量配合，说明资金参与积极':stockPct>0&&volumeRatio<.8?'虽然上涨，但成交量没有跟上，追涨资金仍不积极':'成交量没有出现明显异常，买卖双方暂时都没有形成压倒性力量';
  const closeMeaning=closeLocation>.65?'收盘从日内低位明显拉回，尾盘承接较好':closeLocation<.3?'收盘接近日内低点，说明抛压到尾盘仍未缓解':'收盘处在日内中部，盘中多空暂时没有分出明显胜负';
  const relativeMeaning=volumeReversal?'，相对大盘没有形成足够优势，冲高回落更需要按个股自身兑现压力理解':relative>3?'，而且走势明显强于大盘，说明个股自身仍有承接':relative>1?'，同时跑赢大盘，走势具有一定独立性':relative<-3?'，同时明显弱于大盘，说明个股自身抛压更重':relative<-1?'，并且弱于大盘，当前修复力度不足':'，整体表现与大盘接近，没有形成明显的独立强势';
  const validationMeaning=phaseType==='rejection'?`接下来先看${fmt(prior20High)}附近的平台能否守住，并尽快收复${fmt(dayVwap)}；只有重新越过${fmt(dayHigh)}并收稳，突破才算成立。`:phaseType==='breakout'?`接下来重点看能否守住${fmt(repair)}；守住后继续向上，突破才更可靠。`:['distribution','failed','damage'].includes(phaseType)?`只有重新站回${fmt(repair)}并进一步突破${fmt(confirm)}，弱势结构才算得到修复。`:`接下来先看能否站稳${fmt(repair)}，只有放量越过${fmt(confirm)}，才算真正转强。`;
  const summary=`${nature}。${phaseMeaning}。${volumeMeaning}；${closeMeaning}${relativeMeaning}。${validationMeaning}`;
  let finalGrade='正常回踩 · 等待确认',actionText='当前结构和赔率尚未形成共振，优先等待修复位与确认位给出证据。';
  if(phaseType==='distribution'){finalGrade='高位派发 · 防守优先';actionText='风险形态优先级高于评分，不宜仅因潜在空间而追价。'}
  else if(phaseType==='rejection'){finalGrade='突破遇阻 · 等待承接';actionText='趋势尚未破坏，但短线胜率已经下降；先观察平台能否守住以及均价能否收复，不把放量冲高直接当成有效突破。'}
  else if(phaseType==='failed'){finalGrade='突破失效 · 等待修复';actionText='原突破逻辑已经失效，先观察能否重新收复平台。'}
  else if(phaseType==='damage'){finalGrade='趋势破坏 · 控制风险';actionText='中期支撑已经破坏，当前重点是风险控制而不是寻找上涨空间。'}
  else if(phaseType==='breakout'&&rr<1.2){finalGrade='确认突破 · 不宜追价';actionText='突破已经成立，但剩余上涨空间相对失效风险不足，等待回踩或新目标位重估。'}
  else if(phaseType==='breakout'){finalGrade='确认突破 · 等待跟随';actionText=score>=72&&!historyWeak?'突破与赔率总体匹配，继续观察跟随买盘和确认位承接。':'突破已出现，但评分或历史验证尚未形成强共振，等待跟随买盘。'}
  else if(phaseType==='ready'){finalGrade=rr<1.2?'准备突破 · 不宜追价':'准备突破 · 等待触发';actionText=rr<1.2?'接近阻力但赔率不足，等待更合适价格。':'尚未有效越过阻力，放量站上确认位后再提高参与优先级。'}
  else if(phaseType==='washout'){finalGrade='强势洗盘 · 等待确认';actionText='趋势仍在，但需要快速收复和后续承接确认洗盘判断。'}
  else if(phaseType==='false-break'){finalGrade='假突破 · 等待修复';actionText='价格重新跌回平台，先看修复位能否收回。'}
  else if(phaseType==='bottoming'){finalGrade='低位筑底 · 反转待确认';actionText='低位赔率不等于趋势反转，先等待均线和突破结构转强。'}
  else if(phaseType==='weak'){finalGrade='弱势结构 · 等待转强';actionText=rr>=1.5?'价格位置有一定赔率，但趋势胜率不足，等待结构转强。':'趋势和赔率均未占优，优先等待修复。'}
  else if(rr<1.2){finalGrade='正常回踩 · 不宜追价';actionText='结构尚未失效，但当前价格的风险收益比偏低。'}
  const historyText=history20&&history.sampleSize>=15?`历史相似结构后续20日上涨条件频率${history20.upProb}%（样本${history.sampleSize}，${historyLabel}）`:`历史样本不足，未用于方向性判断`;
  const structureLabel=stage.split(' · ')[0],decisionGrade=`${structureLabel} · ${buyGrade}`;
  const winReason=phaseType==='breakout'?'突破已获得收盘位置和成交量确认':phaseType==='rejection'?'盘中突破没有收稳，后续承接仍待验证':phaseType==='distribution'?'高位放量滞涨和筹码松动压低了继续上涨的把握':phaseType==='failed'?'价格重新跌回平台，原突破逻辑已经失效':phaseType==='damage'?'中期趋势支撑已经破坏':phaseType==='washout'?'趋势仍在，但洗盘判断还需要后续收复确认':phaseType==='ready'?'价格已接近平台上沿，但尚未完成有效突破':phaseType==='false-break'?'突破后重新跌回平台，目前仍在修复窗口':phaseType==='bottoming'?'低位出现修复迹象，但反转尚未确认':phaseType==='weak'?'中期结构偏弱，当前反弹还没有证明趋势反转':'趋势支撑尚存，但短线动能仍在消化';
  const winVerdict=`${winReason}，因此技术胜率处于${winLevel}档；该档位用于比较当前结构质量，不等于真实上涨概率。`;
  const finalDecision={grade:decisionGrade,structure:structureLabel,action:buyGrade,diagnosticGrade:finalGrade,winOdds:`胜率${winLevel} · 赔率${oddsLevel}`,winLevel,oddsLevel,winScore,oddsScore,opportunityScore,winVerdict,text:`胜率评分${score}，当前风险收益比${round(rr,2)}（实际动作：${buyGrade}）；${historyText}。${actionText}`};
  const dims=[['趋势结构',Math.round(adjustedTrend),20],['突破质量',Math.round(adjustedBreakout),15],['量价承接',Math.round(volumeScore),15],['相对强弱',Math.round(relativeScore),15],['动能指标',Math.round(momentumScore),10],['市场适配',Math.round(marketScore),10],['历史验证',round(historyScore,1),10]];
  const levels=[['波段压力',fmt(target)],['再确认位',fmt(confirm)],['修复位',fmt(repair)],['平台上沿',fmt(prior20High)],['当前价',fmt(price),'current'],['日内防守',fmt(dayLow)],['结构失效',fmt(invalidation)]];
  const scenarios=[['#20c997','偏强情景',`守住${fmt(dayLow)}并放量站回${fmt(confirm)}，突破或修复得到确认。`],['#f4bd4b','中性情景',`在${fmt(dayLow)}—${fmt(confirm)}之间震荡，继续等待量价选择方向。`],['#ff5d68','转弱情景',`跌破${fmt(dayLow)}且无法收回；若进一步失守${fmt(invalidation)}，原技术逻辑失效。`]];
  const marketList=[{name:snap['中文简称']||snap['Wind代码'],pct:round(stockPct),relative:round(relative),series:intraday.map(x=>x.close)},{...sh,relative:round(stockPct-sh.pct)},{...sz,relative:round(stockPct-sz.pct)}];if(style)marketList.push({...style,relative:round(stockPct-style.pct)});
  const phaseRisk=phaseType==='distribution'?'高位派发风险':phaseType==='failed'?'突破已经失效':phaseType==='damage'?'趋势支撑破坏':phaseType==='rejection'?'放量冲高回落':phaseType==='bottoming'?'反转尚未确认':phaseType==='false-break'?'突破待修复':'上方压力';
  return {name:snap['中文简称']||snap['Wind代码'],code:snap['Wind代码'],price:round(price),delta:round(num(snap['涨跌'])||price-prevClose),pct:round(stockPct),date:`${today} ${intraday.at(-1).time.slice(11,16)} · Wind实时数据`,source:'Wind',phase:stage,headline,summary,relative:pctText(relative),amp:pctText(amplitude),vr:`${round(volumeRatio,2)}×`,rr:round(rr,2).toFixed(2),score,opportunityScore,dims,finalDecision,historyValidation,open:round(dayOpen),high:round(dayHigh),low:round(dayLow),avg:round(dayVwap),turnover:`${round(turnover,2)}%`,shortGrade,shortText:`短线先看${fmt(repair)}能否收复；放量突破${fmt(confirm)}才算进一步确认。`,swingGrade,swingText:`2—8周首要观察${fmt(target)}压力，只有量价持续配合才打开更高空间。`,buyValue,history,surge,levels,scenarios,market:marketList.map(x=>[x.name,x.pct,x.relative,x.series]),intraday:intraday.map((x,i)=>({t:x.time,p:x.close,o:x.open,h:x.high,l:x.low,v:x.volume,a:vwap[i]})),daily:daily.map(x=>({t:x.time,o:x.open,h:x.high,l:x.low,c:x.close,v:x.volume})),indicators:{ma5:round(ma5),ma10:round(ma10),ma20:round(ma20),ma60:round(ma60),ma120:round(ma120),macd:round(macd,4),bollUpper:round(bollUpper),bollMid:round(bollMid),bollLower:round(bollLower)},limits:['不含Level-2挂单撤单与逐笔成交方向','历史频率为样本内条件统计，不代表未来概率','历史验证占10分并按样本置信度向中性收缩','技术潜力评分不代表收益预测']};
}

async function getMarket(code,name,begin,end){const [q,k]=await Promise.all([windCall('index_data','get_index_quote',{windcode:code,begin:'LAST',end:'LAST'}),windCall('index_data','get_index_kline',{windcode:code,begin_date:begin,end_date:end,period:'10',aftime:'0',issusp:'1'})]);const quote=parseQuote(table(q)),daily=parseDaily(table(k));return {name,code,pct:round(marketPct(daily)),series:quote.map(x=>x.close),quote,daily}}

async function analyze(raw){
  const input=normalizeInput(raw),key=input.toUpperCase();const cached=cache.get(key);if(cached&&Date.now()-cached.time<60000)return cached.data;
  const indexes='中文简称,最新成交价,前收盘价,今日开盘价,今日最高价,今日最低价,成交量,成交额,涨跌,涨跌幅,换手率';
  const snapshot=await windCall('stock_data','get_stock_price_indicators',{windcode:input,indexes});const snapshotRows=table(snapshot);if(!snapshotRows.length)throw new Error('未识别到该A股，请输入六位代码或准确简称');
  const code=snapshotRows[0]['Wind代码'];const end=new Date(),begin=new Date(end);begin.setFullYear(begin.getFullYear()-6);const beginText=dateText(begin),endText=dateText(end);
  const jobs=[windCall('stock_data','get_stock_quote',{windcode:code,begin:'LAST',end:'LAST'}),windCall('stock_data','get_stock_kline',{windcode:code,begin_date:beginText,end_date:endText,period:'10',aftime:'0',issusp:'1'}),getMarket('000001.SH','上证指数',beginText,endText),getMarket('399001.SZ','深证成指',beginText,endText)];
  const styleCode=/^(300|301)/.test(code)?['399006.SZ','创业板指']:/^(688|689)/.test(code)?['000688.SH','科创50']:null;if(styleCode)jobs.push(getMarket(styleCode[0],styleCode[1],beginText,endText));
  const [quote,kline,sh,sz,style]=await Promise.all(jobs),klineRows=table(kline),name=String(snapshotRows[0]['中文简称']||code),profile=surgeProfile(parseDaily(klineRows),name,code);let documents={news:{items:[]},announcements:{items:[]}};
  if(profile.trigger){const cleanName=name.normalize('NFKC').replace(/\s+/g,''),dateRange=eventQueryRange(profile.asOf,3),queries=[`${cleanName}${dateRange}新闻资讯`,`${cleanName}${dateRange}经营债务融资行业政策股价异动`],docs=await Promise.allSettled([windCall('financial_docs','get_financial_news',{query:queries[0],top_k:15}),windCall('financial_docs','get_financial_news',{query:queries[1],top_k:15}),windCall('financial_docs','get_company_announcements',{query:`${cleanName}${dateRange}公司公告`,top_k:15})]);documents={news:{items:[]},announcements:{items:[]},errors:[]};for(let i=0;i<2;i++){if(docs[i].status==='fulfilled')documents.news.items.push(...(docs[i].value?.items||[]));else documents.errors.push(`news${i+1}`)}if(docs[2].status==='fulfilled')documents.announcements.items.push(...(docs[2].value?.items||[]));else documents.errors.push('announcements')}
  const result=buildAnalysis(snapshotRows,table(quote),klineRows,{sh,sz},style,documents);cache.set(key,{time:Date.now(),data:result});return result;
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
